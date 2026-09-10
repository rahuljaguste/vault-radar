import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { receiptHash, verifyReceipt, type Receipt } from "@vaultradar/core";
import { formatUsdc } from "./balances";
import type { VaultRadarClient } from "./client";
import { chooseRail, chooseTier, type Policy } from "./policy";
import { saveRun, type Decision, type RunRecord } from "./runs";
import {
  DEFAULT_TABLE_PROTOCOL,
  executePurchase,
  identityRefusal,
  planChains,
  quoteFor,
  type Amounts,
  type Purchase,
  type PurchaseOutcome,
  type PurchasePlan,
  type RailHealth,
} from "./watch";

/**
 * The agent's standing instructions. Reproduced verbatim from the task brief — the
 * "insufficient data" rule and the citation requirement are the two things that keep a
 * model from dressing up an unverified or stale number as a recommendation, so this
 * text is a spec, not a suggestion.
 */
export const SYSTEM_PROMPT =
  "You are VaultRadar's risk-monitor agent. You buy vault risk data with x402 micropayments under a policy. Never invent numbers. A verdict of unavailable, or an attestation older than the policy's max age, means 'insufficient data'. Every recommendation must cite block numbers, the data source, the payment transaction id and the receipt hash from the tool results. Prefer the cheapest rail unless the policy says otherwise, and the privacy tier the policy requires.";

/** MCP server name; tools reach the model as `mcp__vaultradar__<tool name>`. */
export const MCP_SERVER_NAME = "vaultradar";

export const TOOL_NAMES = [
  "vaultradar_discover",
  "vaultradar_quote",
  "vaultradar_scan",
  "vaultradar_table",
  "vaultradar_verify_receipt",
] as const;

/** Fully-qualified names for `query({ options: { allowedTools } })`. */
export const ALLOWED_TOOLS: string[] = TOOL_NAMES.map(n => `mcp__${MCP_SERVER_NAME}__${n}`);

/**
 * Everything the tools need, assembled once per session. The private keys live inside
 * `client` (and are never read back out here), so nothing in this module can print or
 * persist key material.
 */
export type AgentContext = {
  client: VaultRadarClient;
  policy: Policy;
  runsDir: string;
  serviceUrl: string;
  balances: () => Promise<Amounts>;
  health: () => Promise<RailHealth>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  runId?: () => string;
};

/**
 * Accumulates one run file across a whole chat session. Every purchase appends to the
 * same `RunRecord` and rewrites it — `saveRun` derives its filename from the run's
 * fixed `id` and `startedAt`, so repeated saves overwrite one file rather than
 * littering the directory with partial runs.
 */
export class RunLog {
  private run: RunRecord | null = null;

  constructor(private readonly ctx: AgentContext) {}

  /** The run so far, or null if no purchase has been made yet. */
  current(): RunRecord | null {
    return this.run;
  }

  /** Opens the run on first use, filling the discovery block from the live card. */
  private async ensure(): Promise<RunRecord> {
    if (this.run) return this.run;
    const disc = await this.ctx.client.discover();
    this.run = {
      id: (this.ctx.runId ?? (() => Math.random().toString(36).slice(2, 10)))(),
      startedAt: new Date().toISOString(),
      serviceUrl: this.ctx.serviceUrl,
      policy: this.ctx.policy,
      discovery: {
        cardSignatureValid: disc.cardSignatureValid,
        pubHash: disc.card.pq.sig.pub_hash,
        kid: disc.card.pq.kem.kid,
        onChain: disc.onChain,
      },
      requests: [],
      decisions: [],
    };
    return this.run;
  }

  /**
   * Appends a purchase (and any decisions it produced) and rewrites the run file.
   * Returns the path written, or null if the write failed — a failed write must not
   * lose the purchase that already happened, so the in-memory record keeps it either
   * way and the caller reports the path as unavailable.
   *
   * An outcome with no purchases never reached a payment (no usable rail, a rail the
   * model named that isn't usable), so it opens no run at all. This differs from
   * `runWatch` on purpose: a `watch` invocation is one shot whose whole outcome — even
   * "I declined to pay, here is why" — is worth a run file, whereas a chat session may
   * ask for many things and should not leave an empty run behind for each refusal.
   */
  async append(outcome: PurchaseOutcome): Promise<string | null> {
    if (!outcome.purchases.length) return null;
    const run = await this.ensure();
    run.requests.push(...outcome.purchases.map(p => p.request));
    // Both branches carry decisions: a failed fan-out still holds whatever earlier,
    // fully verified purchases produced, and those belong in the run file. `decisions` is
    // empty on a failure that happened on the first purchase, so this adds nothing then.
    run.decisions = [...run.decisions, ...outcome.decisions];
    try {
      return saveRun(this.ctx.runsDir, run);
    } catch {
      return null;
    }
  }
}

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const err = (message: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  isError: true,
});

const VAULT_ID_RE = /^\d+:0x[0-9a-fA-F]{40}$/;

/** Per-vault view of a purchase, shaped so a model can quote it without re-deriving anything. */
function reportSummary(outcome: { purchases: Purchase[]; decisions: Decision[] }): { decisions: Decision[]; reports: unknown[] } {
  const byVault = new Map(outcome.purchases.flatMap(p => p.result.reports.map(r => [r.vaultId, r] as const)));
  return {
    decisions: outcome.decisions,
    reports: outcome.decisions.map(d => {
      const r = byVault.get(d.vaultId);
      return {
        vaultId: d.vaultId,
        verdict: r?.verdict ?? null,
        score: r?.score ?? null,
        flags: r?.flags ?? [],
        evidence: r?.evidence ?? [],
      };
    }),
  };
}

/**
 * Per-payment detail for the model. Almost always one entry. A strict-tier scan whose
 * vaults span several chains buys one table per chain, and each decision's own
 * `citations.receiptHash` stays the authoritative reference for that vault either way.
 */
function paymentsOf(purchases: Purchase[]) {
  return purchases.map(({ result, request, hcs }) => ({
    rail: result.rail,
    tier: result.tier,
    sealed: result.sealed,
    price_usd: result.priceUsd,
    receipt_hash: request.receiptHash,
    // The rail-level tx id is only set by real payment middleware; the receipt always
    // carries the identifier the payer committed to, so fall back to it.
    tx_id: result.txId ?? result.receipt.payment.txId,
    hcs,
    rejected: request.rejected,
    verified: { receipt: result.receiptValid, attestations: result.attestationsValid },
  }));
}

/** Sums USD decimal strings in atomic micro-USD, so N table prices add up exactly. */
function totalUsd(amounts: (string | null)[]): string {
  const micro = amounts.reduce((sum, a) => sum + (a == null ? 0 : Math.round(Number(a) * 1e6)), 0);
  return formatUsdc(String(micro));
}

/**
 * The five tools the model may call. Everything that decides anything — rail, tier,
 * age, action — runs in `./policy` and `./watch`, not here: these handlers only marshal
 * arguments in and JSON out, so the model cannot talk the agent past its own policy.
 */
export function vaultradarTools(ctx: AgentContext, log: RunLog = new RunLog(ctx)) {
  const purchaseDeps = {
    client: ctx.client,
    policy: ctx.policy,
    balances: ctx.balances,
    health: ctx.health,
    now: ctx.now,
    sleep: ctx.sleep,
    fetchImpl: ctx.fetchImpl,
  };

  /** Shared body for the two paid tools. */
  const buy = async (plan: PurchasePlan) => {
    const disc = await ctx.client.discover();
    const refusal = identityRefusal(disc);
    if (refusal) return err(refusal);

    const outcome = await executePurchase(plan, ctx.serviceUrl, purchaseDeps);
    const runPath = await log.append(outcome);
    if (!outcome.ok) {
      const hashes = outcome.purchases.map(p => p.request.receiptHash).join(", ");
      // Still an isError result — the model must not treat this as a clean purchase — but
      // it carries the decisions from any earlier purchase that did verify. A multi-chain
      // fan-out pays per chain, and a fully verified `withdraw` on chain 1 is exactly the
      // thing that must not vanish because chain 2's receipt failed.
      return err(`${outcome.reason}${hashes ? ` (receipt ${hashes}, recorded in ${runPath ?? "memory only"})` : ""}`, {
        ...reportSummary(outcome),
        payments: paymentsOf(outcome.purchases),
        run_path: runPath,
      });
    }

    const payments = paymentsOf(outcome.purchases);
    const first = payments[0]!;
    return ok({
      ...reportSummary(outcome),
      rail: outcome.rail,
      tier: first.tier,
      sealed: first.sealed,
      price_usd: totalUsd(payments.map(p => p.price_usd)),
      receipt_hash: first.receipt_hash,
      tx_id: first.tx_id,
      hcs: first.hcs,
      rejected: payments.flatMap(p => p.rejected),
      verified: {
        receipt: payments.every(p => p.verified.receipt),
        attestations: payments.every(p => p.verified.attestations),
      },
      payments,
      ...(payments.length > 1
        ? { note: `${payments.length} payments were made, one table per chain; cite each vault's own citations.receiptHash.` }
        : {}),
      run_path: runPath,
    });
  };

  return [
    tool(
      "vaultradar_discover",
      "Fetch and verify the VaultRadar service's signed agent card: its post-quantum signing key, its sealing key, the price list, and whether its key hash matches the ERC-8004 registration it claims on chain. Call this first; it costs nothing.",
      {},
      async () => {
        const d = await ctx.client.discover();
        return ok({
          name: d.card.name,
          card_signature_valid: d.cardSignatureValid,
          // Reported alongside the signature because the two are independent: a card can
          // be correctly signed by the key it ships while advertising someone else's key
          // hash, which is the substitution the on-chain anchor exists to catch. False
          // here means the paid tools will refuse, so the model should see it.
          key_binding_valid: d.keyBindingValid,
          pub_hash: d.card.pq.sig.pub_hash,
          kid: d.card.pq.kem.kid,
          sig_alg: d.card.pq.sig.alg,
          kem_alg: d.card.pq.kem.alg,
          erc8004: d.onChain,
          endpoints: d.card.endpoints,
          prices: d.card.prices,
          limits: d.card.limits,
          policy: ctx.policy,
        });
      },
    ),

    tool(
      "vaultradar_quote",
      "Price a scan of `count` vaults on both payment rails and report which rail the policy would use, with the wallet balances, per-rail budgets and facilitator health behind that choice. Pass the actual `vaults` too whenever you have them: under a strict privacy policy the price depends on how many chains they span, because that tier buys one table per chain. Costs nothing, and contacts nothing: the figures are computed locally from the pricing table shared with the service, and the amount the service actually demands in its 402 is checked against this quote before anything is signed.",
      {
        count: z.number().int().min(1).max(100).describe("How many vaults the scan would cover"),
        vaults: z
          .array(z.string().regex(VAULT_ID_RE, "must be <chainId>:<0x address>"))
          .max(100)
          .optional()
          .describe("The vault ids themselves, if known — needed to price a strict-tier (table) purchase correctly"),
      },
      async ({ count, vaults }) => {
        const tier = chooseTier(ctx.policy);
        // A strict-tier purchase is one table per distinct chain, so the preview has to
        // count chains, not vaults. Without the ids there is nothing to count, and the
        // quote can only assume a single chain — said out loud below rather than quietly.
        const chains = vaults?.length ? planChains({ kind: "policy", vaults }, tier.tier) : [];
        const requests = Math.max(1, chains.length);
        const effectiveCount = vaults?.length ?? count;
        const [scanQuotes, tierQuotes] = await Promise.all([
          quoteFor(ctx.client, "scan", effectiveCount),
          quoteFor(ctx.client, tier.tier, effectiveCount, requests),
        ]);
        const [balances, health] = await Promise.all([ctx.balances(), ctx.health()]);
        const choice = chooseRail(ctx.policy, tierQuotes, balances, health);
        const assumesOneChain = tier.tier === "table" && !vaults?.length;
        return ok({
          count: effectiveCount,
          tier: tier.tier,
          sealed: tier.seal,
          ...(tier.tier === "table" ? { tables: requests, chains } : {}),
          scan_quotes_usd: scanQuotes,
          quotes_usd_for_policy_tier: tierQuotes,
          balances_usd: balances,
          budgets_usd: ctx.policy.budget,
          facilitator_health: health,
          chosen_rail: choice.rail,
          reason: choice.reason,
          ...(assumesOneChain
            ? { note: "This policy buys a table per chain; without the vault ids the quote assumes one chain. Pass `vaults` for an exact price." }
            : {}),
        });
      },
    ),

    tool(
      "vaultradar_scan",
      "Buy risk reports for specific vaults. Picks the rail and privacy tier from the policy, pays the x402 micropayment, verifies the signed receipt and per-vault attestations, rejects attestations older than the policy's max age, and returns one decision per vault with its citations. This spends money: one call, one payment.",
      {
        vaults: z
          .array(z.string().regex(VAULT_ID_RE, "must be <chainId>:<0x address>"))
          .min(1)
          .max(100)
          .describe('Vault ids like "1:0xabc…" (chain id, colon, checksum-insensitive address)'),
      },
      async ({ vaults }) => buy({ kind: "policy", vaults, protocol: DEFAULT_TABLE_PROTOCOL }),
    ),

    tool(
      "vaultradar_table",
      "Buy the whole risk table for one protocol on one chain. Always sealed, so the service never learns which vault is of interest. Costs more than a small scan but reveals nothing. This spends money: one call, one payment.",
      {
        protocol: z.string().min(1).describe('Protocol name, e.g. "erc4626" or "aave-v3"'),
        chainId: z.string().regex(/^\d+$/).describe('Decimal chain id, e.g. "1"'),
      },
      async ({ protocol, chainId }) => buy({ kind: "table", protocol, chainId }),
    ),

    tool(
      "vaultradar_verify_receipt",
      "Check a receipt's ML-DSA-65 signature against the service's discovered signing key and report its hash, the request and response hashes it commits to, the price, the payment and the HCS topic. Use this to re-verify a receipt from an earlier run. Costs nothing.",
      { receipt: z.unknown().describe("A receipt object, exactly as it appeared in a scan or table result") },
      async ({ receipt }) => {
        const d = await ctx.client.discover();
        const r = receipt as Receipt;
        if (!r || typeof r !== "object" || !("sig" in r)) return err("not a receipt: no `sig` field");
        let valid: boolean;
        let hash: string;
        try {
          valid = verifyReceipt(r, d.sigPk);
          hash = receiptHash(r);
        } catch (e) {
          return err(`receipt could not be checked: ${e instanceof Error ? e.message : String(e)}`);
        }
        return ok({
          valid,
          signed_by_this_service: valid,
          receipt_hash: hash,
          request_hash: r.request_hash ?? null,
          response_hash: r.response_hash ?? null,
          tier: r.tier ?? null,
          sealed: r.sealed ?? null,
          price: r.price ?? null,
          payment: r.payment ?? null,
          hcs: r.hcs ?? null,
          issued_at: r.issued_at ?? null,
        });
      },
    ),
  ];
}

/** Wraps the tools as an in-process MCP server for `query({ options: { mcpServers } })`. */
export function createVaultRadarMcpServer(ctx: AgentContext, log: RunLog = new RunLog(ctx)) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    instructions: SYSTEM_PROMPT,
    tools: vaultradarTools(ctx, log),
  });
}
