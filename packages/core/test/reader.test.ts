import { expect, test } from "bun:test";
import { BLOCK_TIME_S, readErc4626Vaults, readSinkCursorBlock, SINK_REF } from "../src/substreams/reader";

const now = 1_760_000_000;

test("reader builds erc4626 UnifiedVault with substreams source from the chain-specific cursor table", async () => {
  const calls: string[] = [];
  const fake = async (text: string) => {
    calls.push(text);
    if (text.includes("cursors_1")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ chain_id: "1", vault: "0xabc", block: "990", share_price: "1.02", total_assets: "5000", total_supply: "4900", net_deposited_assets: "4000", depositor_count: "12", last_event_block: "990", asset_symbol: "USDC", asset_decimals: "6" }] };
    if (text.includes("FROM vault_metrics")) return { rows: [{ block: "900", timestamp: String(now - 4000), share_price: "1.01", net_flow_assets: "-100", total_assets: "5100" }] };
    return { rows: [] };
  };
  // head.block is 5 blocks ahead of the cursor's 1000; chain "1" is 12s/block, so the
  // cursor is 5*12=60s stale — the same 60s age the old directly-timestamped fixture used.
  const [v] = await readErc4626Vaults(fake, "1", ["0xabc"], { ts: now, block: 1005 });
  expect(v.kind).toBe("erc4626");
  expect(v.id).toBe("1:0xabc");
  expect(v.sharePrice).toBe("1.02");
  expect(v.sources[0]).toMatchObject({ kind: "substreams", block: "1000", timestamp: String(now - 60), ageSeconds: "60", freshness: "fresh" });
  expect(v.history[0].netFlowAssets).toBe("-100");
  expect(v.asset).toEqual({ symbol: "USDC", decimals: 6 });
  expect(calls.some(c => c.includes("LIKE"))).toBe(false);
  expect(calls.some(c => c.includes("cursors_1"))).toBe(true);
});

test('chain id "1"\'s cursor lookup never touches chain id "10"\'s cursor table', async () => {
  let cursors10Touched = false;
  const q = async (text: string) => {
    if (text.includes("cursors_10")) { cursors10Touched = true; return { rows: [{ block_num: "1" }] }; }
    if (text.includes("cursors_1")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xabc", share_price: "1", total_assets: "1" }] };
    return { rows: [] };
  };
  await readErc4626Vaults(q, "1", ["0xabc"], { ts: now, block: 1005 });
  expect(cursors10Touched).toBe(false);
});

test("a missing cursor table (chain not yet indexed) yields unavailable freshness and block 0, not a crash", async () => {
  const q = async (text: string) => {
    if (text.includes("cursors_1")) throw new Error('relation "cursors_1" does not exist');
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xabc", share_price: "1.02", total_assets: "5000" }] };
    return { rows: [] };
  };
  const [v] = await readErc4626Vaults(q, "1", ["0xabc"], { ts: now, block: 1005 });
  expect(v.sources[0]).toMatchObject({ block: "0", timestamp: "0", freshness: "unavailable" });
  expect(v.freshness).toBe("unavailable");
});

test("no matching vault_meta row leaves asset null", async () => {
  const q = async (text: string) => {
    if (text.includes("cursors_1")) return { rows: [{ block_num: "1000" }] };
    // No asset_symbol/asset_decimals: the LEFT JOIN against vault_meta found nothing.
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xabc", share_price: "1.02", total_assets: "5000" }] };
    return { rows: [] };
  };
  const [v] = await readErc4626Vaults(q, "1", ["0xabc"], { ts: now, block: 1005 });
  expect(v.asset).toBeNull();
});

test("chain name resolves 8453 to base, an unmapped chainId falls back to itself, and BLOCK_TIME_S defaults to 12s", async () => {
  expect(BLOCK_TIME_S).toEqual({ "1": 12, "8453": 2 });
  const q = async (text: string) => {
    if (text.includes("cursors_8453")) return { rows: [{ block_num: "100" }] };
    if (text.includes("cursors_999")) return { rows: [{ block_num: "100" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xdef", share_price: "1", total_assets: "1" }] };
    return { rows: [] };
  };
  const [base] = await readErc4626Vaults(q, "8453", null, { ts: now, block: 105 }); // 5 blocks * 2s/block = 10s
  expect(base.chain).toBe("base");
  expect(base.sources[0].ageSeconds).toBe("10");
  const [unknown] = await readErc4626Vaults(q, "999", null, { ts: now, block: 105 }); // 5 blocks * default 12s/block = 60s
  expect(unknown.chain).toBe("999");
  expect(unknown.sources[0].ageSeconds).toBe("60");
});

test("readSinkCursorBlock rejects a non-numeric chainId instead of interpolating it unsafely", async () => {
  const q = async () => ({ rows: [] });
  await expect(readSinkCursorBlock(q, "1; drop table cursors_1")).rejects.toThrow();
});

test("readSinkCursorBlock returns null when the cursor table is empty", async () => {
  const empty = async () => ({ rows: [] });
  expect(await readSinkCursorBlock(empty, "1")).toBeNull();
});

test("SINK_REF names the substreams sink module", () => {
  expect(SINK_REF).toBe("substreams:erc4626-vault-metrics");
});
