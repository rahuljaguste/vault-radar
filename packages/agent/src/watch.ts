import { TABLE_PRICE_USD, receiptHash, type Rail } from "@vaultradar/core";
import type { Discovery, PaidResult, VaultRadarClient } from "./client";
import { applyAgeCheck, chooseRail, chooseTier, decide, type AgeCheck, type Policy } from "./policy";
import { saveRun, type Decision, type RunRecord, type RunRequest } from "./runs";

/** Protocol used for the `strict` privacy tier when the caller names none. Every
 *  `<chainId>:<address>` vault id is addressable through the generic ERC-4626 table. */
export const DEFAULT_TABLE_PROTOCOL = "erc4626";

const RECEIPT_POLL_ATTEMPTS = 3;
const RECEIPT_POLL_GAP_MS = 3000;

export type Quotes = { hedera: string | null; arc: string | null };
export type Amounts = { hedera: string; arc: string };
export type RailHealth = { hedera: boolean; arc: boolean };

export type WatchArgs = {
  /** `<chainId>:<address>` ids to report on. */
  vaults: string[];
  serviceUrl: string;
  runsDir: string;
  /** Overrides `policy.rail_preference`; an unusable named rail is an error, not a fallback. */
  rail?: Rail | null;
  /** Only consulted for the `strict` (table) tier. */
  protocol?: string;
};

export type WatchDeps = {
  client: VaultRadarClient;
  policy: Policy;
  balances: () => Promise<Amounts>;
  health: () => Promise<RailHealth>;
  /** Unix seconds; injected so the age check is deterministic under test. */
  now?: () => number;
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Used only for the `/v1/receipts/:hash` HCS poll. */
  fetchImpl?: typeof fetch;
  runId?: () => string;
};

export type WatchOutcome = {
  exitCode: 0 | 2;
  run: RunRecord;
  /** Null only if the run file could not be written. */
  runPath: string | null;
  /** Set when `exitCode` is 2: the one-line reason, already printed. */
  message: string | null;
};

/** The HCS consensus record for a receipt, once the service has mirrored it. */
export type HcsRecord = { topicId: string | null; sequence: number | null };

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Polls `/v1/receipts/:hash` for the Hedera Consensus Service sequence number the
 * service assigns once it has published the receipt. The publish is asynchronous, so a
 * `sequence` of null right after a purchase is normal — hence the retries. Never
 * throws: an unreachable or malformed lookup is reported as "no sequence yet", which
 * must not invalidate a purchase that already succeeded.
 */
export async function pollHcs(
  serviceUrl: string,
  hash: string,
  o: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number; gapMs?: number } = {},
): Promise<HcsRecord> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const attempts = o.attempts ?? RECEIPT_POLL_ATTEMPTS;
  const gap = o.gapMs ?? RECEIPT_POLL_GAP_MS;
  const url = `${serviceUrl.replace(/\/$/, "")}/v1/receipts/${hash}`;
  let last: HcsRecord = { topicId: null, sequence: null };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(gap);
    try {
      const res = await f(url);
      if (!res.ok) continue;
      const body = (await res.json()) as { topicId?: string | null; sequence?: number | null };
      last = { topicId: body.topicId ?? null, sequence: typeof body.sequence === "number" ? body.sequence : null };
      if (last.sequence != null) return last;
    } catch {
      // Keep polling: the receipt is already signed and in hand either way.
    }
  }
  return last;
}

/**
 * Narrows a `PaidResult` to a set of vault ids, used for the `strict` tier: the agent
 * buys a whole protocol table (so the service never learns which vault it cares about)
 * and filters locally. `receiptValid`/`attestationsValid` are carried through
 * unchanged — they were computed over the full body that was actually signed, and
 * re-deriving them from a subset would check a body the service never attested to.
 */
export function narrowResult(result: PaidResult, ids: string[]): PaidResult {
  const want = new Set(ids.map(v => v.toLowerCase()));
  const keep = (id: string) => want.has(id.toLowerCase());
  return {
    ...result,
    vaults: result.vaults.filter(v => keep(v.id)),
    reports: result.reports.filter(r => keep(r.vaultId)),
    attestations: result.attestations.filter(a => keep(a.vaultId)),
  };
}

/** Folds a purchase into the run-file shape the dashboard reads. */
export function buildRunRequest(result: PaidResult, age: AgeCheck): RunRequest {
  return {
    rail: result.rail,
    tier: result.tier,
    sealed: result.sealed,
    priceUsd: result.priceUsd,
    txId: result.txId,
    receiptHash: receiptHash(result.receipt),
    receipt: result.receipt,
    verdicts: result.reports.map(r => ({ vaultId: r.vaultId, verdict: r.verdict, score: r.score, flags: r.flags })),
    rejected: age.rejected,
  };
}

/**
 * Quotes both rails for the tier that is actually going to be bought. `client.quote()`
 * prices a scan; the table tier is a flat price, so non-null scan quotes (which is how
 * the client reports "this rail is configured") are mapped to it.
 */
export async function quoteFor(client: VaultRadarClient, tier: "scan" | "table", count: number): Promise<Quotes> {
  const scan = await client.quote(count);
  if (tier === "scan") return scan;
  return { hedera: scan.hedera == null ? null : TABLE_PRICE_USD, arc: scan.arc == null ? null : TABLE_PRICE_USD };
}

/**
 * What to buy. `policy` lets `chooseTier` decide (and narrows a strict-tier table down
 * to the named vaults); `table` names a protocol table explicitly, which is what the
 * `vaultradar_table` tool exposes and is never narrowed.
 */
export type PurchasePlan =
  | { kind: "policy"; vaults: string[]; protocol?: string }
  | { kind: "table"; protocol: string; chainId: string };

export type PurchaseDeps = {
  client: VaultRadarClient;
  policy: Policy;
  balances: () => Promise<Amounts>;
  health: () => Promise<RailHealth>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Overrides `policy.rail_preference`; an unusable named rail is an error, not a fallback. */
  rail?: Rail | null;
};

/** Everything that went into picking a rail, so a caller can explain its own outcome. */
export type PurchaseContext = {
  tier: "scan" | "table";
  seal: boolean;
  quotes: Quotes;
  balances: Amounts;
  health: RailHealth;
};

export type PurchaseOutcome =
  | {
      ok: true;
      ctx: PurchaseContext;
      rail: Rail;
      choiceReason: string;
      result: PaidResult;
      age: AgeCheck;
      decisions: Decision[];
      request: RunRequest;
      hcs: HcsRecord;
    }
  | {
      ok: false;
      ctx: PurchaseContext;
      reason: string;
      /** Set when the failure happened after payment, so the attempt stays auditable. */
      result: PaidResult | null;
      request: RunRequest | null;
      hcs: HcsRecord | null;
    };

/** Human-readable account of what each rail offered, for the no-usable-rail message. */
function railSummary(p: Policy, quotes: Quotes, balances: Amounts, health: RailHealth): string {
  return (["hedera", "arc"] as const)
    .map(rail => {
      const budget = rail === "hedera" ? p.budget.usdc_hedera : p.budget.usdc_arc;
      return `${rail}: quote ${quotes[rail] ?? "n/a"}, balance ${balances[rail]}, budget ${budget}, facilitator ${health[rail] ? "up" : "down"}`;
    })
    .join("; ");
}

/**
 * Refuses to spend against a service whose identity doesn't check out: an agent card
 * that doesn't verify under its own declared key, or a key hash that disagrees with the
 * ERC-8004 registration it points at. Returns the reason to refuse, or null to proceed.
 * A `matches: null` entry (no RPC configured for that chain) is *not* a refusal — it is
 * an unverified claim, reported as such by the caller.
 */
export function identityRefusal(disc: Discovery): string | null {
  if (!disc.cardSignatureValid) return "the service's agent card signature did not verify — refusing to pay";
  const mismatch = disc.onChain.find(e => e.matches === false);
  if (mismatch) {
    return `the service's key hash does not match its on-chain ERC-8004 registration (chain ${mismatch.chainId}, agent ${mismatch.agentId}) — refusing to pay`;
  }
  return null;
}

/**
 * The one paid step, shared by `watch` and the `vaultradar_scan`/`vaultradar_table`
 * tools: price both rails for the tier the policy asks for, pick a usable rail, buy
 * exactly once, re-check attestation age against the policy's own bar, and refuse to
 * derive any decision from a purchase whose receipt or attestations did not verify.
 *
 * Never throws for a policy or verification outcome — those come back as `ok: false`
 * with a reason and, when payment already happened, the `RunRequest` that records it.
 * A transport or payment failure still throws, since the caller can't usefully continue.
 */
export async function executePurchase(plan: PurchasePlan, serviceUrl: string, deps: PurchaseDeps): Promise<PurchaseOutcome> {
  const { client, policy } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const planned = plan.kind === "policy" ? chooseTier(policy) : { tier: "table" as const, seal: true };
  const count = plan.kind === "policy" ? plan.vaults.length : 0;
  const quotes = await quoteFor(client, planned.tier, count);
  const [balances, health] = await Promise.all([deps.balances(), deps.health()]);
  const ctx: PurchaseContext = { ...planned, quotes, balances, health };

  const forced = deps.rail ?? null;
  const choice = chooseRail(forced ? { ...policy, rail_preference: forced } : policy, quotes, balances, health);
  if (choice.rail == null) {
    return { ok: false, ctx, reason: `no usable rail — ${railSummary(policy, quotes, balances, health)}`, result: null, request: null, hcs: null };
  }
  if (forced && choice.rail !== forced) {
    // An operator or model that named a rail gets told it is unusable rather than
    // silently charged on the other one.
    return {
      ok: false,
      ctx,
      reason: `requested rail ${forced} is unusable — ${railSummary(policy, quotes, balances, health)}`,
      result: null,
      request: null,
      hcs: null,
    };
  }
  const rail = choice.rail;

  let result: PaidResult;
  if (plan.kind === "table") {
    result = await client.table(plan.protocol, plan.chainId, rail);
  } else if (planned.tier === "scan") {
    result = await client.scan(plan.vaults, rail, { seal: planned.seal });
  } else {
    // Strict tier: buy the whole protocol table so the service never learns which
    // vault the agent cares about, then filter locally.
    const chainId = plan.vaults[0]?.split(":")[0] ?? "1";
    result = narrowResult(await client.table(plan.protocol ?? DEFAULT_TABLE_PROTOCOL, chainId, rail), plan.vaults);
  }

  const age = applyAgeCheck(result, policy, now());
  const request = buildRunRequest(result, age);
  const hcs = await pollHcs(serviceUrl, request.receiptHash, { fetchImpl: deps.fetchImpl, sleep: deps.sleep });

  if (!result.receiptValid || !result.attestationsValid) {
    const failed = [!result.receiptValid ? "receipt" : null, !result.attestationsValid ? "attestations" : null].filter(Boolean).join(" and ");
    return {
      ok: false,
      ctx,
      reason: `verification failed (${failed}) — the purchase is recorded but no action was taken`,
      result,
      request,
      hcs,
    };
  }

  return { ok: true, ctx, rail, choiceReason: choice.reason, result, age, decisions: decide(result, age), request, hcs };
}

const pad = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s.padEnd(w));
const shortId = (id: string) => {
  const [chainId, address] = id.split(":");
  return address && address.length > 14 ? `${chainId}:${address.slice(0, 8)}…${address.slice(-4)}` : id;
};

function table(headers: string[], widths: number[], rows: string[][]): string[] {
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map(w => "-".repeat(w))), ...rows.map(line)];
}

/**
 * The two tables `watch` prints. The first is the verdict and the action; the second
 * is the evidence behind it, so every row can be checked independently: the block and
 * source the numbers came from, the on-chain payment that bought them, the hash of the
 * signed receipt, and the HCS sequence that receipt was published at.
 */
export function formatDecisions(
  result: PaidResult,
  decisions: Decision[],
  hcs: HcsRecord,
): string[] {
  const byVault = new Map(result.reports.map(r => [r.vaultId, r]));
  const seq = hcs.sequence == null ? "pending" : String(hcs.sequence);
  // The receipt's own payment.txId is the identifier the payer committed to; the
  // rail-level `txId` is only present when real payment middleware set the header.
  const txId = result.txId ?? result.receipt.payment.txId;

  const risk = table(
    ["VAULT", "VERDICT", "SCORE", "ACTION", "FLAGS"],
    [45, 11, 5, 17, 40],
    decisions.map(d => {
      const r = byVault.get(d.vaultId);
      return [
        d.vaultId,
        r?.verdict ?? "unknown",
        r ? String(r.score) : "-",
        d.action,
        r && r.flags.length ? r.flags.map(f => f.name).join(",") : "none",
      ];
    }),
  );

  const evidence = table(
    ["VAULT", "BLOCK", "SOURCE", "TX ID", "RECEIPT", "HCS SEQ"],
    [18, 10, 34, 26, 14, 8],
    decisions.map(d => [
      shortId(d.vaultId),
      d.citations.block || "-",
      d.citations.source || "-",
      txId,
      d.citations.receiptHash.slice(0, 12) + "…",
      seq,
    ]),
  );

  const hash = decisions[0]?.citations.receiptHash ?? receiptHash(result.receipt);
  return [
    "",
    ...risk,
    "",
    ...evidence,
    "",
    ...decisions.map(d => `  ${shortId(d.vaultId)}: ${d.reason}`),
    "",
    `  rail ${result.rail}  tier ${result.tier}  sealed ${result.sealed}  price $${result.priceUsd ?? "?"}`,
    `  receipt hash  ${hash}`,
    `  hcs           topic ${hcs.topicId ?? (result.receipt.hcs.topicId || "none")} sequence ${seq}`,
    `  payment tx    ${txId}`,
    `  verified      receipt ${result.receiptValid ? "ok" : "FAILED"}, attestations ${result.attestationsValid ? "ok" : "FAILED"}`,
  ];
}

/**
 * One non-interactive monitoring pass: verify the service's identity, pick a rail and
 * privacy tier under the policy, buy exactly one request, re-check attestation age
 * against the policy's own bar, decide, print the evidence and persist the run.
 *
 * Returns an exit code rather than calling `process.exit`, so the whole pipeline is
 * testable in-process. Exit 2 means nothing was acted on: a failed identity check, no
 * usable rail, an explicitly requested rail that isn't usable, or a purchase whose
 * receipt or attestations did not verify. In every one of those cases the run file is
 * still written, so the attempt stays auditable.
 */
export async function runWatch(args: WatchArgs, deps: WatchDeps): Promise<WatchOutcome> {
  const { client, policy } = deps;
  const out = deps.out ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const startedAt = new Date().toISOString();
  const id = (deps.runId ?? (() => Math.random().toString(36).slice(2, 10)))();

  const disc = await client.discover();
  const run: RunRecord = {
    id,
    startedAt,
    serviceUrl: args.serviceUrl,
    policy,
    discovery: {
      cardSignatureValid: disc.cardSignatureValid,
      pubHash: disc.card.pq.sig.pub_hash,
      kid: disc.card.pq.kem.kid,
      onChain: disc.onChain,
    },
    requests: [],
    decisions: [],
  };

  const finish = (exitCode: 0 | 2, message: string | null): WatchOutcome => {
    let runPath: string | null = null;
    try {
      runPath = saveRun(args.runsDir, run);
      out(`  run saved     ${runPath}`);
    } catch (e) {
      out(`  run NOT saved: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (message) out(`error: ${message}`);
    return { exitCode, run, runPath, message };
  };

  out(`VaultRadar ${args.serviceUrl}`);
  out(`  identity      card signature ${disc.cardSignatureValid ? "ok" : "INVALID"}, pub hash ${run.discovery.pubHash}`);
  for (const e of disc.onChain) {
    const state = e.matches == null ? "unverified (no RPC for this chain)" : e.matches ? "matches" : "MISMATCH";
    out(`  erc-8004      chain ${e.chainId} agent ${e.agentId}: ${state}`);
  }

  // The identity gate comes before any spend: paying a service whose signing key isn't
  // the one it registered on chain is exactly what the on-chain pin exists to prevent.
  const refusal = identityRefusal(disc);
  if (refusal) return finish(2, refusal);

  const outcome = await executePurchase(
    { kind: "policy", vaults: args.vaults, protocol: args.protocol },
    args.serviceUrl,
    { client, policy, balances: deps.balances, health: deps.health, now, sleep: deps.sleep, fetchImpl: deps.fetchImpl, rail: args.rail ?? null },
  );
  const { ctx } = outcome;
  out(`  policy        privacy ${policy.privacy} -> ${ctx.tier}${ctx.seal ? " (sealed)" : " (clear)"}, max age ${policy.max_age_seconds}s`);
  out(`  rails         ${railSummary(policy, ctx.quotes, ctx.balances, ctx.health)}`);

  if (outcome.request) run.requests.push(outcome.request);
  if (!outcome.ok) {
    // A post-payment failure is still printed, so the operator sees the evidence that
    // the purchase happened and why nothing was acted on.
    if (outcome.result && outcome.hcs) for (const line of formatDecisions(outcome.result, [], outcome.hcs)) out(line);
    return finish(2, outcome.reason);
  }

  out(`  bought        ${ctx.tier} on ${outcome.rail} for $${ctx.quotes[outcome.rail]} (${outcome.choiceReason})`);
  run.decisions = outcome.decisions;
  for (const line of formatDecisions(outcome.result, outcome.decisions, outcome.hcs)) out(line);
  return finish(0, null);
}
