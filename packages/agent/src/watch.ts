import { TABLE_PRICE_USD, receiptHash, type Rail } from "@vaultradar/core";
import { formatUsdc } from "./balances";
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

/**
 * The HCS consensus record for a receipt, once the service has published it.
 *
 * `sequence` is a **string**, matching the service's own `LookupResult`: an HCS sequence
 * number is an int64, so it does not survive a round trip through a JS number, and the
 * service never sends it as one. Reading it as a number is how this silently reported
 * "pending" for every receipt the service had in fact already committed.
 */
export type HcsRecord = { topicId: string | null; sequence: string | null };

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
      // The service sends `sequence` as a string (int64); a number is accepted too rather
      // than discarded, so a future or older shape still yields a usable citation.
      const body = (await res.json()) as { topicId?: string | null; sequence?: string | number | null };
      const seq = body.sequence;
      const sequence = typeof seq === "string" && seq.length ? seq : typeof seq === "number" ? String(seq) : null;
      last = { topicId: body.topicId ?? null, sequence };
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
 * Quotes both rails for the tier that is actually going to be bought, for the *whole*
 * plan. `client.quote()` prices a scan; the table tier is a flat price per table, so
 * non-null scan quotes (which is how the client reports "this rail is configured") are
 * mapped to `requests × TABLE_PRICE_USD`.
 *
 * Multiplying by `requests` is what keeps the budget honest: a strict-tier run spanning
 * three chains buys three tables, and quoting one table's price would let it spend 3× the
 * policy's cap while `chooseRail` reported the rail as affordable.
 */
export async function quoteFor(client: VaultRadarClient, tier: "scan" | "table", count: number, requests = 1): Promise<Quotes> {
  const scan = await client.quote(count);
  if (tier === "scan") return scan;
  // Multiplied in atomic micro-USD so N tables price exactly. With the current 0.06 table
  // price, `0.06 * 11` in binary floats is 0.6599999999999999, which compares greater than
  // a budget of "0.66" and would refuse a plan the policy allows. Integer micro-USD does
  // not: USDC has six decimals, so every amount either side can hold is exact there.
  // (An earlier version of this comment cited `0.03 * 3`, which is in fact exactly 0.09 —
  // the hazard is real, that example was not.)
  const total = formatUsdc(String(Math.round(Number(TABLE_PRICE_USD) * 1e6) * Math.max(1, requests)));
  return { hedera: scan.hedera == null ? null : total, arc: scan.arc == null ? null : total };
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

/** One paid request and everything derived from it. */
export type Purchase = {
  result: PaidResult;
  age: AgeCheck;
  request: RunRequest;
  hcs: HcsRecord;
  /** The chain this table was bought for; null for a scan, which spans chains. */
  chainId: string | null;
};

export type PurchaseOutcome =
  | {
      ok: true;
      ctx: PurchaseContext;
      rail: Rail;
      choiceReason: string;
      /** One entry per paid request: a strict-tier plan spanning N chains buys N tables. */
      purchases: Purchase[];
      /** Across every purchase, plus one per requested vault that no table carried. */
      decisions: Decision[];
    }
  | {
      ok: false;
      ctx: PurchaseContext;
      reason: string;
      /** Purchases that completed before the failure, so every payment stays auditable. */
      purchases: Purchase[];
      /**
       * Decisions from the purchases that *did* verify, before the one that didn't. A
       * multi-chain fan-out pays per chain, so a failure on the last chain must not throw
       * away a fully verified `alert` on the first — it was paid for, it verified, and
       * suppressing it is the one outcome an operator cannot afford to miss. Empty when
       * the first purchase is the one that failed.
       */
      decisions: Decision[];
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

/** Chain id out of a `<chainId>:<address>` vault id. */
const chainOf = (vaultId: string) => vaultId.split(":")[0] ?? "1";

/**
 * The distinct chains a plan's tables must cover, in first-seen order. Empty for a scan,
 * which is a single request covering every named vault regardless of chain.
 *
 * A table is per protocol *per chain*, so a strict-tier vault list spanning two chains
 * needs two tables. Taking only the first chain would silently drop every other vault
 * from the results.
 */
export function planChains(plan: PurchasePlan, tier: "scan" | "table"): string[] {
  if (plan.kind === "table") return [plan.chainId];
  if (tier === "scan") return [];
  return [...new Set(plan.vaults.map(chainOf))];
}

/**
 * `insufficient data` decisions for vaults that were asked about but appear in none of
 * the tables that were bought — a vault id that doesn't exist, or belongs to a different
 * protocol than the one whose table was fetched. Silently returning nothing for them
 * would read as "no risk found" when the truth is "never looked at".
 *
 * Each cites the receipt of the table bought for that vault's own chain, which is the
 * document that proves what was and wasn't in it.
 */
export function missingVaultDecisions(requested: string[], purchases: Purchase[]): Decision[] {
  const covered = new Set(purchases.flatMap(p => p.result.reports.map(r => r.vaultId.toLowerCase())));
  // Keyed off the chain each table was *bought for*, not off the vaults it returned — a
  // table that came back empty is exactly the one that proves the vault isn't there.
  const byChain = new Map<string, Purchase>();
  for (const p of purchases) if (p.chainId && !byChain.has(p.chainId)) byChain.set(p.chainId, p);
  return requested
    .filter(v => !covered.has(v.toLowerCase()))
    .map(vaultId => {
      const source = byChain.get(chainOf(vaultId)) ?? purchases[0];
      return {
        vaultId,
        action: "insufficient data" as const,
        reason: `This vault was not present in the fetched table(s), so nothing about it was bought.`,
        citations: {
          block: "",
          source: "",
          txId: source ? source.result.txId ?? source.result.receipt.payment.txId : null,
          receiptHash: source?.request.receiptHash ?? "",
        },
      };
    });
}

/**
 * The paid step, shared by `watch` and the `vaultradar_scan`/`vaultradar_table` tools:
 * price both rails for the whole plan, pick a usable rail, buy, re-check attestation age
 * against the policy's own bar, and refuse to derive any decision from a purchase whose
 * receipt or attestations did not verify.
 *
 * Usually one payment. A strict-tier plan whose vaults span several chains buys one table
 * per chain, sequentially, and stops at the first verification failure rather than
 * continuing to spend against a service that just failed a check. Decisions already
 * derived from the chains that *did* verify survive that stop and come back on the
 * failure branch: they were paid for and they verified, so dropping them would hide a
 * real `alert` behind an unrelated later fault.
 *
 * Never throws for a policy or verification outcome — those come back as `ok: false` with
 * a reason, every payment that did happen in `purchases`, and whatever verified. A
 * transport or payment failure still throws, since the caller can't usefully continue.
 */
export async function executePurchase(plan: PurchasePlan, serviceUrl: string, deps: PurchaseDeps): Promise<PurchaseOutcome> {
  const { client, policy } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const planned = plan.kind === "policy" ? chooseTier(policy) : { tier: "table" as const, seal: true };
  const count = plan.kind === "policy" ? plan.vaults.length : 0;
  const chains = planChains(plan, planned.tier);
  const quotes = await quoteFor(client, planned.tier, count, chains.length);
  const [balances, health] = await Promise.all([deps.balances(), deps.health()]);
  const ctx: PurchaseContext = { ...planned, quotes, balances, health };

  const forced = deps.rail ?? null;
  const choice = chooseRail(forced ? { ...policy, rail_preference: forced } : policy, quotes, balances, health);
  if (choice.rail == null) {
    return { ok: false, ctx, reason: `no usable rail — ${railSummary(policy, quotes, balances, health)}`, purchases: [], decisions: [] };
  }
  if (forced && choice.rail !== forced) {
    // An operator or model that named a rail gets told it is unusable rather than
    // silently charged on the other one.
    return {
      ok: false,
      ctx,
      reason: `requested rail ${forced} is unusable — ${railSummary(policy, quotes, balances, health)}`,
      purchases: [],
      decisions: [],
    };
  }
  const rail = choice.rail;
  const protocol = plan.kind === "table" ? plan.protocol : plan.protocol ?? DEFAULT_TABLE_PROTOCOL;

  const purchases: Purchase[] = [];
  const decisions: Decision[] = [];

  // One scan, or one table per chain. Sequential on purpose: each iteration is a real
  // payment, and a failure must stop the spending rather than race N of them out.
  const buys: { chainId: string | null; buy: () => Promise<PaidResult> }[] =
    planned.tier === "scan" && plan.kind === "policy"
      ? [{ chainId: null, buy: () => client.scan(plan.vaults, rail, { seal: planned.seal }) }]
      : chains.map(chainId => ({
          chainId,
          buy: async () => {
            const table = await client.table(protocol, chainId, rail);
            // The strict tier buys the whole table so the service never learns which
            // vault the agent cares about, then filters locally. An explicit
            // `vaultradar_table` call is never narrowed.
            return plan.kind === "policy" ? narrowResult(table, plan.vaults) : table;
          },
        }));

  for (const { chainId, buy } of buys) {
    const result = await buy();
    const age = applyAgeCheck(result, policy, now());
    const request = buildRunRequest(result, age);
    const hcs = await pollHcs(serviceUrl, request.receiptHash, { fetchImpl: deps.fetchImpl, sleep: deps.sleep });
    purchases.push({ result, age, request, hcs, chainId });

    if (!result.receiptValid || !result.attestationsValid) {
      const failed = [!result.receiptValid ? "receipt" : null, !result.attestationsValid ? "attestations" : null].filter(Boolean).join(" and ");
      // `decisions` holds only what earlier, fully verified purchases produced; nothing is
      // derived from this failed one.
      //
      // Deliberately *no* `missingVaultDecisions` here. A vault the failed table would
      // have covered is not "not present in the fetched table(s)" — that table was
      // fetched, it just could not be verified, and claiming absence would be a false
      // statement about data the agent never got to read. The failure reason is the
      // honest account for those vaults.
      const verified = purchases.length - 1;
      const carried = decisions.length
        ? `; ${decisions.length} decision(s) from ${verified} earlier verified purchase(s) still stand`
        : "";
      return {
        ok: false,
        ctx,
        reason:
          purchases.length === 1
            ? `verification failed (${failed}) — the purchase is recorded but no action was taken on it`
            : `verification failed (${failed}) on payment ${purchases.length} of ${purchases.length} — all ${purchases.length} purchases are recorded, but nothing was derived from the failed one${carried}`,
        purchases,
        decisions,
      };
    }
    decisions.push(...decide(result, age));
  }

  if (plan.kind === "policy") decisions.push(...missingVaultDecisions(plan.vaults, purchases));

  return { ok: true, ctx, rail, choiceReason: choice.reason, purchases, decisions };
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
 * The two tables `watch` prints, plus one footer block per payment. The first table is
 * the verdict and the action; the second is the evidence behind it, so every row can be
 * checked independently: the block and source the numbers came from, the on-chain payment
 * that bought them, the hash of the signed receipt, and the HCS sequence that receipt was
 * published at.
 *
 * The evidence table is driven off each decision's own `citations`, not off the purchase,
 * so the printed values and the ones persisted to the run file are the same by
 * construction — a reviewer comparing the terminal to `runs/*.json` sees one set of
 * numbers. With several payments, each row's HCS sequence is looked up by the receipt
 * hash that row cites.
 */
export function formatDecisions(purchases: Purchase[], decisions: Decision[]): string[] {
  const byVault = new Map(purchases.flatMap(p => p.result.reports.map(r => [r.vaultId, r] as const)));
  const hcsByReceipt = new Map(purchases.map(p => [p.request.receiptHash, p.hcs] as const));
  const seqFor = (receiptHashHex: string) => {
    const hcs = hcsByReceipt.get(receiptHashHex);
    if (!hcs) return "-";
    return hcs.sequence == null ? "pending" : String(hcs.sequence);
  };

  const risk = table(
    // 52 fits the longest id in play: a 7-digit chain (Arc testnet is 5042002), a colon,
    // and a 42-char address. Narrower truncates the address, which is the one column a
    // reader has to be able to copy verbatim.
    ["VAULT", "VERDICT", "SCORE", "ACTION", "FLAGS"],
    [52, 11, 5, 17, 40],
    decisions.map(d => {
      const r = byVault.get(d.vaultId);
      return [
        d.vaultId,
        r?.verdict ?? "absent",
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
      d.citations.txId ?? "-",
      d.citations.receiptHash ? d.citations.receiptHash.slice(0, 12) + "…" : "-",
      seqFor(d.citations.receiptHash),
    ]),
  );

  const footers = purchases.flatMap(({ result, request, hcs }, i) => {
    const seq = hcs.sequence == null ? "pending" : String(hcs.sequence);
    const label = purchases.length > 1 ? ` (payment ${i + 1} of ${purchases.length})` : "";
    return [
      `  rail ${result.rail}  tier ${result.tier}  sealed ${result.sealed}  price $${result.priceUsd ?? "?"}${label}`,
      `  receipt hash  ${request.receiptHash}`,
      `  hcs           topic ${hcs.topicId ?? (result.receipt.hcs.topicId || "none")} sequence ${seq}`,
      `  payment tx    ${result.txId ?? result.receipt.payment.txId}`,
      `  verified      receipt ${result.receiptValid ? "ok" : "FAILED"}, attestations ${result.attestationsValid ? "ok" : "FAILED"}`,
    ];
  });

  return [
    "",
    ...risk,
    "",
    ...evidence,
    "",
    ...decisions.map(d => `  ${shortId(d.vaultId)}: ${d.reason}`),
    "",
    ...footers,
  ];
}

/**
 * One non-interactive monitoring pass: verify the service's identity, pick a rail and
 * privacy tier under the policy, buy (normally one request; one table per chain under
 * `strict` when the vaults span several), re-check attestation age against the policy's
 * own bar, decide, print the evidence and persist the run.
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

  run.requests.push(...outcome.purchases.map(p => p.request));
  if (!outcome.ok) {
    // A post-payment failure is still printed, so the operator sees the evidence that
    // the purchase happened and why nothing was acted on. Decisions from earlier
    // purchases that did verify are printed and persisted too — a `withdraw` that was
    // paid for and verified must not be swallowed by a later chain's fault. The exit code
    // stays 2: the run as a whole did not complete, and the reason says what carried.
    run.decisions = outcome.decisions;
    if (outcome.purchases.length) for (const line of formatDecisions(outcome.purchases, outcome.decisions)) out(line);
    return finish(2, outcome.reason);
  }

  const payments = outcome.purchases.length === 1 ? "" : ` in ${outcome.purchases.length} payments`;
  out(`  bought        ${ctx.tier} on ${outcome.rail} for $${ctx.quotes[outcome.rail]}${payments} (${outcome.choiceReason})`);
  run.decisions = outcome.decisions;
  for (const line of formatDecisions(outcome.purchases, outcome.decisions)) out(line);
  return finish(0, null);
}
