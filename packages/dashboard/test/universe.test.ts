import { describe, expect, test } from "bun:test";
import { buildVaultRows, type DecisionRecord, type VerdictRecord } from "../lib/universe";

/**
 * A verdict as the risk engine writes it. `history` is optional for the reason `lib/types.ts`
 * gives: the agent's own runs never write one, and the committed demo fixture predates the
 * field, so a run with no series is the normal case rather than a broken one.
 */
const verdict = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
  vaultId: "1:0xaaaa000000000000000000000000000000000001",
  verdict: "ok",
  score: 0,
  flags: [],
  ...over,
});

const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  vaultId: "1:0xaaaa000000000000000000000000000000000001",
  action: "hold",
  reason: "Verdict ok at score 0 with no flags: hold.",
  citations: { block: "25957940", source: "substreams:erc4626-vault-metrics", txId: "0.0.7162784@1789176159.407789041", receiptHash: "c67e8437" },
  ...over,
});

/** A flat series of `n` hourly points ending at `end`, all at price `v`. */
const series = (n: number, end: number, v = 1): { t: number; v: number }[] =>
  Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) * 3600, v }));

describe("buildVaultRows", () => {
  test("ranks the scored vaults by score, worst first", () => {
    const rows = buildVaultRows(
      [verdict({ vaultId: "a", score: 0 }), verdict({ vaultId: "b", score: 72 }), verdict({ vaultId: "c", score: 41 })],
      [],
    );
    expect(rows.map((r) => r.vaultId)).toEqual(["b", "c", "a"]);
    expect(rows.map((r) => r.score)).toEqual([72, 41, 0]);
  });

  test("puts the vaults with no data last, whatever their score says", () => {
    // `unavailable` is a refusal, not a mild ok. A run whose every vault is refused must not
    // look like a clean bill of health, and one that sorts by score alone would hide that.
    const rows = buildVaultRows(
      [verdict({ vaultId: "refused", verdict: "unavailable", score: 0 }), verdict({ vaultId: "quiet", score: 5 })],
      [],
    );
    expect(rows.map((r) => r.vaultId)).toEqual(["quiet", "refused"]);
  });

  test("breaks a tie deterministically rather than leaving order to the input", () => {
    const rows = buildVaultRows([verdict({ vaultId: "z" }), verdict({ vaultId: "a" }), verdict({ vaultId: "m" })], []);
    expect(rows.map((r) => r.vaultId)).toEqual(["a", "m", "z"]);
  });

  test("measures the week's and the day's change against the latest price", () => {
    // 100 an hour ago for the day, 200 a week ago for the week: 1.0 is a 100% gain on the
    // newest price of 2.0, and -50% against the 0.5 that was current a week back.
    const now = 1_800_000_000;
    const points = [
      { t: now - 8 * 86400, v: 0.5 },
      { t: now - 6 * 86400, v: 1 },
      { t: now - 3600, v: 1 },
      { t: now, v: 2 },
    ];
    const [row] = buildVaultRows([verdict({ history: points })], []);
    expect(row.change7d).toBeCloseTo(300, 6); // 0.5 -> 2.0
    expect(row.change24h).toBeCloseTo(100, 6); // 1.0 -> 2.0
    expect(row.series).toHaveLength(4);
  });

  test("keeps a vault with too little history, with no change figures", () => {
    // The table must not silently drop it: "we bought a verdict for this vault and it has no
    // series" is a fact worth a row, and dropping it would make the count disagree with the
    // number of vaults actually paid for.
    const rows = buildVaultRows([verdict({ vaultId: "bare", history: series(1, 1_800_000_000) })], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].change7d).toBeNull();
    expect(rows[0].change24h).toBeNull();
    expect(rows[0].series).toHaveLength(1);
  });

  test("treats a missing series as no series rather than as an error", () => {
    const rows = buildVaultRows([verdict({ vaultId: "agent-run" })], []);
    expect(rows[0].series).toEqual([]);
    expect(rows[0].change7d).toBeNull();
    expect(rows[0].change24h).toBeNull();
  });

  test("refuses to invent a percentage change from a zero price", () => {
    const now = 1_800_000_000;
    const rows = buildVaultRows([verdict({ history: [{ t: now - 8 * 86400, v: 0 }, { t: now, v: 2 }] })], []);
    expect(rows[0].change7d).toBeNull();
  });

  test("carries the flags through for the view to format", () => {
    const flags = [{ name: "share_price_drawdown_7d", value: "-0.124000", threshold: "0.050000", window: "7d" }];
    const [row] = buildVaultRows([verdict({ flags })], []);
    expect(row.flags).toEqual(flags);
  });

  test("attaches the decision that matches the vault, and nothing to one that has none", () => {
    const rows = buildVaultRows(
      [verdict({ vaultId: "a" }), verdict({ vaultId: "b" })],
      [decision({ vaultId: "a", reason: "withdraw", citations: { block: "9", source: "s", txId: null, receiptHash: "h" } })],
    );
    const a = rows.find((r) => r.vaultId === "a")!;
    const b = rows.find((r) => r.vaultId === "b")!;
    expect(a.citation).toEqual({ block: "9", source: "s", txId: null, receiptHash: "h" });
    expect(a.reason).toBe("withdraw");
    expect(b.citation).toBeNull();
    expect(b.reason).toBeNull();
  });

  test("keeps one row per vault when two paid requests both returned a verdict for it", () => {
    // A run can hold more than one request, and a vault can be bought twice across them. Two
    // rows for one vault would collide on the React key and read as two separate holdings, so
    // the more severe reading wins.
    const rows = buildVaultRows(
      [verdict({ vaultId: "dup", verdict: "ok", score: 3 }), verdict({ vaultId: "dup", verdict: "alert", score: 80 })],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(80);
    expect(rows[0].verdict).toBe("alert");
  });
});
