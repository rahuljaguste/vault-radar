import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptHash } from "@vaultradar/core";
import { VaultRadarClient } from "../src/client";
import type { RunRecord } from "../src/runs";
import {
  ALLOWED_TOOLS,
  MCP_SERVER_NAME,
  RunLog,
  SYSTEM_PROMPT,
  TOOL_NAMES,
  createVaultRadarMcpServer,
  vaultradarTools,
  type AgentContext,
} from "../src/tools";
import { ALERT_VAULT, NOW, STALE_VAULT, TEST_HCS_SEQUENCE, TEST_TX_ID, UNUSED_HEDERA_KEY, startHarness } from "./harness";

const h = await startHarness();

function context(over: Partial<AgentContext> = {}): AgentContext {
  return {
    client: h.client(),
    policy: h.policy(),
    runsDir: mkdtempSync(join(tmpdir(), "vaultradar-tools-")),
    serviceUrl: h.base,
    balances: async () => ({ hedera: "5.00", arc: "0" }),
    health: async () => ({ hedera: true, arc: false }),
    now: () => NOW,
    sleep: async () => {},
    fetchImpl: fetch,
    runId: () => "toolrun",
    ...over,
  };
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/** Calls a tool by name and parses the JSON its handler returned. */
async function call(ctx: AgentContext, log: RunLog, name: string, args: unknown): Promise<{ body: any; isError: boolean }> {
  const t = vaultradarTools(ctx, log).find(x => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  const res = (await t.handler(args as never, {})) as ToolResult;
  return { body: JSON.parse(res.content[0]!.text), isError: res.isError === true };
}

test("the five tools are registered under the vaultradar MCP server with the documented names", () => {
  const tools = vaultradarTools(context());
  expect(tools.map(t => t.name)).toEqual([
    "vaultradar_discover",
    "vaultradar_quote",
    "vaultradar_scan",
    "vaultradar_table",
    "vaultradar_verify_receipt",
  ]);
  expect(tools.map(t => t.name)).toEqual([...TOOL_NAMES]);
  expect(ALLOWED_TOOLS).toEqual([
    "mcp__vaultradar__vaultradar_discover",
    "mcp__vaultradar__vaultradar_quote",
    "mcp__vaultradar__vaultradar_scan",
    "mcp__vaultradar__vaultradar_table",
    "mcp__vaultradar__vaultradar_verify_receipt",
  ]);
  // Every tool carries a description the model can act on.
  for (const t of tools) expect(t.description.length).toBeGreaterThan(40);

  const server = createVaultRadarMcpServer(context());
  expect(server.type).toBe("sdk");
  expect(server.name).toBe(MCP_SERVER_NAME);
});

test("the system prompt is the brief's text verbatim", () => {
  expect(SYSTEM_PROMPT).toBe(
    "You are VaultRadar's risk-monitor agent. You buy vault risk data with x402 micropayments under a policy. Never invent numbers. A verdict of unavailable, or an attestation older than the policy's max age, means 'insufficient data'. Every recommendation must cite block numbers, the data source, the payment transaction id and the receipt hash from the tool results. Prefer the cheapest rail unless the policy says otherwise, and the privacy tier the policy requires.",
  );
});

test("vaultradar_discover reports the verified card, the on-chain key pin and the policy", async () => {
  const ctx = context();
  const { body, isError } = await call(ctx, new RunLog(ctx), "vaultradar_discover", {});
  expect(isError).toBe(false);
  expect(body.card_signature_valid).toBe(true);
  expect(body.pub_hash).toBe(h.keys.sig.pubHash);
  expect(body.kid).toBe(h.keys.kem.kid);
  expect(body.sig_alg).toBe("ML-DSA-65");
  expect(body.erc8004).toEqual([{ chainId: "296", agentId: "7", matches: true }]);
  expect(body.policy).toEqual(h.policy());
});

test("vaultradar_quote prices both rails for the policy's tier and names the rail it would use", async () => {
  const ctx = context();
  const { body } = await call(ctx, new RunLog(ctx), "vaultradar_quote", { count: 3 });
  expect(body.count).toBe(3);
  expect(body.tier).toBe("scan");
  expect(body.sealed).toBe(true);
  expect(body.scan_quotes_usd).toEqual({ hedera: "0.0025", arc: null });
  expect(body.balances_usd).toEqual({ hedera: "5.00", arc: "0" });
  expect(body.budgets_usd).toEqual({ usdc_hedera: "1.00", usdc_arc: "1.00" });
  expect(body.facilitator_health).toEqual({ hedera: true, arc: false });
  expect(body.chosen_rail).toBe("hedera");
});

test("a strict policy quotes the table price, because that is what it would actually buy", async () => {
  const ctx = context({ policy: h.policy({ privacy: "strict" }) });
  const { body } = await call(ctx, new RunLog(ctx), "vaultradar_quote", { count: 3 });
  expect(body.tier).toBe("table");
  expect(body.scan_quotes_usd.hedera).toBe("0.0025");
  expect(body.quotes_usd_for_policy_tier.hedera).toBe("0.03");
  expect(body.chosen_rail).toBe("hedera");
});

test("a strict-tier quote prices one table per distinct chain when given the vault ids", async () => {
  const ctx = context({ policy: h.policy({ privacy: "strict" }) });
  const log = new RunLog(ctx);
  const two = await call(ctx, log, "vaultradar_quote", {
    count: 2,
    vaults: [ALERT_VAULT, "137:0x" + "d".repeat(40)],
  });
  expect(two.body.tier).toBe("table");
  expect(two.body.tables).toBe(2);
  expect(two.body.chains).toEqual(["1", "137"]);
  expect(two.body.quotes_usd_for_policy_tier.hedera).toBe("0.06"); // 2 x 0.03
  expect(two.body.note).toBeUndefined();

  // Two vaults on one chain is still a single table.
  const one = await call(ctx, log, "vaultradar_quote", { count: 2, vaults: [ALERT_VAULT, STALE_VAULT] });
  expect(one.body.tables).toBe(1);
  expect(one.body.chains).toEqual(["1"]);
  expect(one.body.quotes_usd_for_policy_tier.hedera).toBe("0.03");

  // Without the ids the chain spread is unknowable, so the quote says it assumed one
  // chain rather than quietly under-pricing a fan-out.
  const blind = await call(ctx, log, "vaultradar_quote", { count: 2 });
  expect(blind.body.tables).toBe(1);
  expect(blind.body.note).toContain("assumes one chain");

  // A scan-tier policy is one request regardless of how many chains the vaults span.
  const scanCtx = context();
  const scan = await call(scanCtx, new RunLog(scanCtx), "vaultradar_quote", {
    count: 2,
    vaults: [ALERT_VAULT, "137:0x" + "d".repeat(40)],
  });
  expect(scan.body.tier).toBe("scan");
  expect(scan.body.tables).toBeUndefined();
  expect(scan.body.quotes_usd_for_policy_tier.hedera).toBe("0.002");
  expect(scan.body.note).toBeUndefined();
});

test("a later chain's verification failure still returns the earlier chain's verified decisions", async () => {
  // Same regression as in watch: the scan tool pays per chain under a strict policy, and a
  // fully verified `withdraw` on chain 1 must not vanish because chain 2's receipt failed.
  let calls = 0;
  const ctx = context({
    policy: h.policy({ privacy: "strict" }),
    client: new VaultRadarClient({
      serviceUrl: h.base,
      hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
      payingFetch: async (url, init) => {
        calls += 1;
        const res = await fetch(url, init);
        if (calls === 1) return res; // chain 1: untouched
        const body = (await res.json()) as { receipt: { request_hash: string } };
        body.receipt.request_hash = "0".repeat(64);
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
      readPqHash: async () => h.keys.sig.pubHash,
    }),
  });
  const log = new RunLog(ctx);
  const { body, isError } = await call(ctx, log, "vaultradar_scan", {
    vaults: [ALERT_VAULT, "137:0x" + "d".repeat(40)],
  });

  // Still an error: the model must not read this as a clean purchase.
  expect(isError).toBe(true);
  expect(body.error).toMatch(/verification failed \(receipt\)/);
  expect(body.error).toContain("still stand");
  // But chain 1's verified decision comes back, with its own citations.
  expect(body.decisions).toHaveLength(1);
  expect(body.decisions[0]).toMatchObject({ vaultId: ALERT_VAULT, action: "withdraw" });
  expect(body.reports[0]).toMatchObject({ vaultId: ALERT_VAULT, verdict: "alert" });
  // Both payments are reported, the second marked unverified.
  expect(body.payments).toHaveLength(2);
  expect(body.payments[0].verified).toEqual({ receipt: true, attestations: true });
  expect(body.payments[1].verified.receipt).toBe(false);
  expect(body.decisions[0].citations.receiptHash).toBe(body.payments[0].receipt_hash);
  // And the run file keeps both payments plus the one decision that stands.
  expect(log.current()!.requests).toHaveLength(2);
  expect(log.current()!.decisions).toHaveLength(1);
  const saved = JSON.parse(readFileSync(body.run_path, "utf8")) as RunRecord;
  expect(saved.decisions).toHaveLength(1);
});

test("vaultradar_scan pays, verifies, decides, and appends a RunRecord the dashboard can read", async () => {
  const ctx = context();
  const log = new RunLog(ctx);
  const { body, isError } = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  expect(isError).toBe(false);
  expect(body.rail).toBe("hedera");
  expect(body.tier).toBe("scan");
  expect(body.sealed).toBe(true);
  expect(body.price_usd).toBe("0.0015");
  expect(body.tx_id).toBe(TEST_TX_ID);
  expect(body.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(body.hcs).toEqual({ topicId: "0.0.99", sequence: TEST_HCS_SEQUENCE });
  expect(body.verified).toEqual({ receipt: true, attestations: true });
  expect(body.rejected).toEqual([]);

  expect(body.decisions).toHaveLength(1);
  expect(body.decisions[0].vaultId).toBe(ALERT_VAULT);
  expect(body.decisions[0].action).toBe("withdraw");
  expect(body.decisions[0].citations).toEqual({
    block: "4242",
    source: "substreams:erc4626-vault-metrics",
    // Falls back to the receipt's own payment id, matching `tx_id` above, so the model
    // cannot cite a tx id the run file does not carry.
    txId: TEST_TX_ID,
    receiptHash: body.receipt_hash,
  });
  // The per-vault report the model is meant to quote from, not re-derive.
  expect(body.reports[0]).toMatchObject({ vaultId: ALERT_VAULT, verdict: "alert", score: 55 });
  expect(body.reports[0].flags.map((f: { name: string }) => f.name)).toEqual([
    "share_price_drawdown_1h",
    "share_price_drawdown_24h",
  ]);
  expect(body.reports[0].evidence[0].block).toBe("4242");

  const saved = JSON.parse(readFileSync(body.run_path, "utf8")) as RunRecord;
  expect(Object.keys(saved).sort()).toEqual(["decisions", "discovery", "id", "policy", "requests", "serviceUrl", "startedAt"]);
  expect(saved.id).toBe("toolrun");
  expect(saved.requests).toHaveLength(1);
  expect(saved.decisions).toHaveLength(1);
  expect(log.current()!.requests).toHaveLength(1);
});

test("two scans in one session append to the same run file rather than writing two", async () => {
  const ctx = context();
  const log = new RunLog(ctx);
  const first = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  const second = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  expect(second.body.run_path).toBe(first.body.run_path);
  const saved = JSON.parse(readFileSync(second.body.run_path, "utf8")) as RunRecord;
  expect(saved.requests).toHaveLength(2);
  expect(saved.decisions).toHaveLength(2);
});

test("an attestation past the policy's max age comes back as insufficient data, and is recorded as rejected", async () => {
  const ctx = context({ policy: h.policy({ max_age_seconds: 10 }) });
  const log = new RunLog(ctx);
  const { body } = await call(ctx, log, "vaultradar_scan", { vaults: [STALE_VAULT] });
  expect(body.reports[0].verdict).toBe("ok"); // the service called it fine
  expect(body.rejected).toEqual([{ vaultId: STALE_VAULT, ageSeconds: 60 }]);
  expect(body.decisions[0].action).toBe("insufficient data");
});

test("a strict policy makes vaultradar_scan buy the whole table and narrow it locally", async () => {
  const ctx = context({ policy: h.policy({ privacy: "strict" }) });
  const log = new RunLog(ctx);
  const { body } = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  expect(body.tier).toBe("table");
  expect(body.price_usd).toBe("0.03");
  expect(body.decisions.map((d: { vaultId: string }) => d.vaultId)).toEqual([ALERT_VAULT]);
});

test("vaultradar_table buys a named protocol table without narrowing it", async () => {
  const ctx = context();
  const log = new RunLog(ctx);
  const { body, isError } = await call(ctx, log, "vaultradar_table", { protocol: "erc4626", chainId: "1" });
  expect(isError).toBe(false);
  expect(body.tier).toBe("table");
  expect(body.sealed).toBe(true);
  expect(body.decisions).toHaveLength(3); // every vault in the table
});

test("no usable rail is an isError result naming the quote, balance, budget and health", async () => {
  const ctx = context({ balances: async () => ({ hedera: "0", arc: "0" }) });
  const log = new RunLog(ctx);
  const { body, isError } = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  expect(isError).toBe(true);
  expect(body.error).toContain("no usable rail");
  expect(body.error).toContain("balance 0");
  expect(log.current()).toBeNull(); // nothing was bought, so no run was opened
});

test("an on-chain key-hash mismatch is refused before any payment", async () => {
  const ctx = context({
    client: new VaultRadarClient({
      serviceUrl: h.base,
      hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
      payingFetch: async () => {
        throw new Error("paid request must not happen after a key-hash mismatch");
      },
      readPqHash: async () => "0".repeat(64),
    }),
  });
  const log = new RunLog(ctx);
  const { body, isError } = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  expect(isError).toBe(true);
  expect(body.error).toMatch(/on-chain/i);
});

test("a verification failure is an isError result that still records the purchase in the run", async () => {
  const ctx = context({
    policy: h.policy({ privacy: "cheap" }),
    client: new VaultRadarClient({
      serviceUrl: h.base,
      hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
      // Rewrites the receipt's request_hash: the signature still verifies, the
      // commitment does not.
      payingFetch: async (url, init) => {
        const res = await fetch(url, init);
        const body = (await res.json()) as { receipt: { request_hash: string } };
        body.receipt.request_hash = "0".repeat(64);
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
      readPqHash: async () => h.keys.sig.pubHash,
    }),
  });
  const log = new RunLog(ctx);
  const { body, isError } = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  expect(isError).toBe(true);
  expect(body.error).toMatch(/verification failed \(receipt\)/);
  expect(log.current()!.requests).toHaveLength(1);
  expect(log.current()!.decisions).toEqual([]);
});

test("vaultradar_verify_receipt checks a real receipt and rejects a tampered one", async () => {
  const ctx = context();
  const log = new RunLog(ctx);
  const scan = await call(ctx, log, "vaultradar_scan", { vaults: [ALERT_VAULT] });
  const receipt = log.current()!.requests[0]!.receipt;

  const good = await call(ctx, log, "vaultradar_verify_receipt", { receipt });
  expect(good.isError).toBe(false);
  expect(good.body.valid).toBe(true);
  expect(good.body.receipt_hash).toBe(scan.body.receipt_hash);
  expect(good.body.receipt_hash).toBe(receiptHash(receipt));
  expect(good.body.tier).toBe("scan");
  expect(good.body.payment).toEqual({ rail: "hedera", txId: TEST_TX_ID });

  const tampered = await call(ctx, log, "vaultradar_verify_receipt", {
    receipt: { ...receipt, price: { ...receipt.price, amount: "1" } },
  });
  expect(tampered.body.valid).toBe(false);

  const notAReceipt = await call(ctx, log, "vaultradar_verify_receipt", { receipt: { hello: "world" } });
  expect(notAReceipt.isError).toBe(true);
  expect(notAReceipt.body.error).toContain("not a receipt");
});
