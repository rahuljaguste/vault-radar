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
  // Per-block rows, each carrying its own block's movement — so `risk.ts` may sum them all
  // over a window without double-counting, unlike a merged hourly+daily Messari history.
  expect(v.history[0].series).toBe("block");
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

/** Postgres signals an undefined table with SQLSTATE 42P01; `pg` puts it on `error.code`. */
const undefinedTable = (table: string) =>
  Object.assign(new Error(`relation "${table}" does not exist`), { code: "42P01" });

test("a database that exists but was never set up yields no vaults instead of throwing", async () => {
  // The state between pointing DATABASE_URL at a fresh Postgres and running
  // `substreams-sink-sql setup`. Every sink-backed chain query hit this, and the throw
  // escaped the reader and turned the whole request into a 500.
  const q = async (text: string) => {
    if (text.includes("cursors_1")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) throw undefinedTable("vault_latest");
    if (text.includes("FROM vault_metrics")) throw undefinedTable("vault_metrics");
    return { rows: [] };
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const out = await readErc4626Vaults(q, "1", ["0xabc"], { ts: now, block: 1005 });
    expect(out).toEqual([]);
    // A missing table is the expected "not set up yet" state, so it must not be logged as
    // a fault — that is what separates it from a real database outage.
    expect(warnings).toEqual([]);
  } finally { console.warn = realWarn; }
});

test("a database outage also yields no vaults, but is logged", async () => {
  const q = async (text: string) => {
    if (text.includes("cursors_1")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    return { rows: [] };
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    expect(await readErc4626Vaults(q, "1", ["0xabc"], { ts: now, block: 1005 })).toEqual([]);
    expect(warnings.join(" ")).toContain("connection refused");
  } finally { console.warn = realWarn; }
});

test("a missing cursor table (chain not yet indexed) yields unavailable freshness and block 0, not a crash", async () => {
  const q = async (text: string) => {
    if (text.includes("cursors_1")) throw undefinedTable("cursors_1");
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xabc", share_price: "1.02", total_assets: "5000" }] };
    return { rows: [] };
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const [v] = await readErc4626Vaults(q, "1", ["0xabc"], { ts: now, block: 1005 });
    expect(v.sources[0]).toMatchObject({ block: "0", timestamp: "0", freshness: "unavailable" });
    expect(v.freshness).toBe("unavailable");
  } finally {
    console.warn = realWarn;
  }
  // "Not indexed yet" is an expected state, not a problem to report.
  expect(warnings).toEqual([]);
});

test("any cursor error other than a missing table is logged once, naming the chain and nothing else", async () => {
  // A bare `catch { return null }` made a database outage look exactly like "this chain is
  // not indexed yet" — the difference between paging an operator and doing nothing.
  const q = async (text: string) => {
    if (text.includes("cursors_1")) throw new Error("password authentication failed for user in postgres://u:p@h/db");
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: "0xabc", share_price: "1.02", total_assets: "5000" }] };
    return { rows: [] };
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  let block: { block: string } | null;
  try {
    block = await readSinkCursorBlock(q, "1");
  } finally {
    console.warn = realWarn;
  }
  // Still null, so callers keep degrading rather than failing.
  expect(block).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("chain 1");
  // Enough of the error to act on...
  expect(warnings[0]).toContain("password authentication failed");
  // ...and none of the query, and nothing URL-shaped, so a driver that echoes its own DSN
  // into an error cannot put the password in the log.
  expect(warnings[0]).not.toContain("SELECT");
  expect(warnings[0]).not.toContain("postgres://");
  expect(warnings[0]).not.toContain("u:p@h");
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
