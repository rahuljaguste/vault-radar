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
  quoteFor,
  type Amounts,
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
    if (outcome.ok) run.decisions = [...run.decisions, ...outcome.decisions];
    try {
      return saveRun(this.ctx.runsDir, run);
    } catch {
      return null;
    }
  }
}

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const err = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  isError: true,
});

const VAULT_ID_RE = /^\d+:0x[0-9a-fA-F]{40}$/;

/** Per-vault view of a purchase, shaped so a model can quote it without re-deriving anything. */
function reportSummary(outcome: Extract<PurchaseOutcome, { ok: true }>): { decisions: Decision[]; reports: unknown[] } {
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
      return err(`${outcome.reason}${hashes ? ` (receipt ${hashes}, recorded in ${runPath ?? "memory only"})` : ""}`);
    }

    // Almost always one payment. A strict-tier scan whose vaults span several chains buys
    // one table per chain, so the per-payment detail lives in `purchases`; the singular
    // keys describe the first payment, and each decision's own `citations.receiptHash`
    // remains the authoritative reference for that vault either way.
    const payments = outcome.purchases.map(({ result, request, hcs }) => ({
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
      "Price a scan of `count` vaults on both payment rails and report which rail the policy would use, with the wallet balances, per-rail budgets and facilitator health behind that choice. Costs nothing.",
      { count: z.number().int().min(1).max(100).describe("How many vaults the scan would cover") },
      async ({ count }) => {
        const tier = chooseTier(ctx.policy);
        const [scanQuotes, tierQuotes] = await Promise.all([
          quoteFor(ctx.client, "scan", count),
          quoteFor(ctx.client, tier.tier, count),
        ]);
        const [balances, health] = await Promise.all([ctx.balances(), ctx.health()]);
        const choice = chooseRail(ctx.policy, tierQuotes, balances, health);
        return ok({
          count,
          tier: tier.tier,
          sealed: tier.seal,
          scan_quotes_usd: scanQuotes,
          quotes_usd_for_policy_tier: tierQuotes,
          balances_usd: balances,
          budgets_usd: ctx.policy.budget,
          facilitator_health: health,
          chosen_rail: choice.rail,
          reason: choice.reason,
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
