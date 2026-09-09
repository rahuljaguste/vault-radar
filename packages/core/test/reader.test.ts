import { expect, test } from "bun:test";
import { readErc4626Vaults, readSinkCursorBlock, SINK_REF } from "../src/substreams/reader";

const now = 1_760_000_000;

const fake = async (text: string) => {
  if (text.includes("FROM cursors")) return { rows: [{ block_num: "1000", timestamp: String(now - 60) }] };
  if (text.includes("FROM vault_latest")) return { rows: [{ chain_id: "1", vault: "0xabc", block: "990", timestamp: String(now - 100), share_price: "1.02", total_assets: "5000", total_supply: "4900", net_deposited_assets: "4000", depositor_count: "12", last_event_block: "990", asset_symbol: "USDC", asset_decimals: "6" }] };
  if (text.includes("FROM vault_metrics")) return { rows: [{ block: "900", timestamp: String(now - 4000), share_price: "1.01", net_flow_assets: "-100", total_assets: "5100" }] };
  return { rows: [] };
};

test("reader builds erc4626 UnifiedVault with substreams source from cursor", async () => {
  const [v] = await readErc4626Vaults(fake, "1", ["0xabc"], now);
  expect(v.kind).toBe("erc4626");
  expect(v.id).toBe("1:0xabc");
  expect(v.sharePrice).toBe("1.02");
  expect(v.sources[0]).toMatchObject({ kind: "substreams", block: "1000", freshness: "fresh" });
  expect(v.history[0].netFlowAssets).toBe("-100");
  expect(v.asset).toEqual({ symbol: "USDC", decimals: 6 });
});

test("no cursor row means unavailable freshness and block 0, not a crash", async () => {
  const noCursor = async (text: string) => {
    if (text.includes("FROM cursors")) return { rows: [] };
    if (text.includes("FROM vault_latest")) return { rows: [{ chain_id: "1", vault: "0xabc", share_price: "1.02", total_assets: "5000" }] };
    return { rows: [] };
  };
  const [v] = await readErc4626Vaults(noCursor, "1", null, now);
  expect(v.sources[0]).toMatchObject({ block: "0", timestamp: "0", freshness: "unavailable" });
  expect(v.freshness).toBe("unavailable");
});

test("chain name resolves 8453 to base and falls back to chainId otherwise", async () => {
  const oneVault = async (text: string) => {
    if (text.includes("FROM cursors")) return { rows: [{ block_num: "1", timestamp: String(now) }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xdef", share_price: "1", total_assets: "1" }] };
    return { rows: [] };
  };
  const [base] = await readErc4626Vaults(oneVault, "8453", null, now);
  expect(base.chain).toBe("base");
  const [other] = await readErc4626Vaults(oneVault, "999", null, now);
  expect(other.chain).toBe("999");
});

test("readSinkCursorBlock returns null with no matching cursor row", async () => {
  const empty = async () => ({ rows: [] });
  expect(await readSinkCursorBlock(empty, "1")).toBeNull();
});

test("SINK_REF names the substreams sink module", () => {
  expect(SINK_REF).toBe("substreams:erc4626-vault-metrics");
});
