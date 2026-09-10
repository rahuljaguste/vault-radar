import { expect, test } from "bun:test";
import {
  DEFAULT_MAX_SCANS_PER_HOUR,
  DEFAULT_SPEND_CAP_USD,
  SCAN_WINDOW_MS,
  SPEND_WINDOW_MS,
  SpendLedger,
  limitsFrom,
  microToUsd,
  usdToMicro,
} from "../lib/spend";

/** A ledger whose clock the test drives, so nothing here sleeps. */
function fixture(env: Record<string, string | undefined> = {}) {
  let t = 1_700_000_000_000;
  const ledger = new SpendLedger(env, () => t);
  return { ledger, advance: (ms: number) => (t += ms), at: () => t };
}

test("the documented defaults are a dollar a day and twenty scans an hour", () => {
  expect(DEFAULT_SPEND_CAP_USD).toBe("1.00");
  expect(DEFAULT_MAX_SCANS_PER_HOUR).toBe(20);
  expect(SPEND_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  expect(SCAN_WINDOW_MS).toBe(60 * 60 * 1000);
  expect(limitsFrom({})).toEqual({ capMicroUsd: 1_000_000, maxScansPerHour: 20 });
});

test("the limits come from the environment when it names usable ones", () => {
  expect(limitsFrom({ DASHBOARD_SPEND_CAP_USD: "0.25", DASHBOARD_MAX_SCANS_PER_HOUR: "3" })).toEqual({
    capMicroUsd: 250_000,
    maxScansPerHour: 3,
  });
});

test("an unusable limit falls back to the default, never to no limit", () => {
  // The failure mode of a typo must not be an uncapped wallet.
  for (const bad of ["", "   ", "free", "0", "-1", "NaN", "1.0.0"]) {
    expect(limitsFrom({ DASHBOARD_SPEND_CAP_USD: bad, DASHBOARD_MAX_SCANS_PER_HOUR: bad })).toEqual({
      capMicroUsd: 1_000_000,
      maxScansPerHour: 20,
    });
  }
  // A non-integer scan count is not a count.
  expect(limitsFrom({ DASHBOARD_MAX_SCANS_PER_HOUR: "2.5" }).maxScansPerHour).toBe(20);
});

test("micro-USD conversion is exact for every amount this protocol handles", () => {
  expect(usdToMicro("1.00")).toBe(1_000_000);
  expect(usdToMicro("0.0015")).toBe(1500);
  expect(usdToMicro("0.051")).toBe(51_000);
  expect(microToUsd(1500)).toBe("0.0015");
  expect(microToUsd(1_000_000)).toBe("1");
  expect(microToUsd(0)).toBe("0");
});

test("the aggregate cap refuses the purchase that would cross it, and allows the one that lands on it", () => {
  // 0.01 USD of allowance, in single-vault scans of 0.0015 each: six fit (0.009), the
  // seventh would be 0.0105 and is refused.
  const { ledger } = fixture({ DASHBOARD_SPEND_CAP_USD: "0.01", DASHBOARD_MAX_SCANS_PER_HOUR: "100" });
  const scan = usdToMicro("0.0015");
  for (let i = 0; i < 6; i++) {
    expect(ledger.canSpend(scan)).toBe(true);
    ledger.record(scan);
  }
  expect(ledger.snapshot().spentMicroUsd).toBe(9000);
  const refusal = ledger.refuse(scan);
  expect(refusal).toEqual({ reason: "spend_cap_24h", spentUsd: "0.009", wouldSpendUsd: "0.0015", capUsd: "0.01" });

  // A cheaper purchase that exactly reaches the cap is still allowed: the cap is inclusive.
  expect(ledger.canSpend(1000)).toBe(true);
  ledger.record(1000);
  expect(ledger.snapshot().spentMicroUsd).toBe(10_000);
  expect(ledger.canSpend(1)).toBe(false);
});

test("the spend window rolls, so yesterday's purchases stop counting", () => {
  const { ledger, advance } = fixture({ DASHBOARD_SPEND_CAP_USD: "0.002", DASHBOARD_MAX_SCANS_PER_HOUR: "100" });
  ledger.record(usdToMicro("0.0015"));
  expect(ledger.canSpend(usdToMicro("0.0015"))).toBe(false);

  advance(SPEND_WINDOW_MS - 1);
  expect(ledger.canSpend(usdToMicro("0.0015"))).toBe(false); // still inside the window
  advance(2);
  expect(ledger.canSpend(usdToMicro("0.0015"))).toBe(true); // aged out
  expect(ledger.snapshot().spentMicroUsd).toBe(0);
});

test("the hourly scan allowance is global and refuses the scan after it, price notwithstanding", () => {
  // A generous spend cap, so the only thing that can refuse here is the scan count. This
  // is the limit that matters against a caller whose purchases are individually tiny.
  const { ledger, advance } = fixture({ DASHBOARD_SPEND_CAP_USD: "100.00", DASHBOARD_MAX_SCANS_PER_HOUR: "3" });
  for (let i = 0; i < 3; i++) {
    expect(ledger.canSpend(1500)).toBe(true);
    ledger.record(1500);
  }
  expect(ledger.refuse(1500)).toEqual({ reason: "scan_rate_1h", scansLastHour: 3, maxScansPerHour: 3 });
  // Even a free purchase is refused: the allowance is about requests, not money.
  expect(ledger.canSpend(0)).toBe(false);

  advance(SCAN_WINDOW_MS + 1);
  expect(ledger.canSpend(1500)).toBe(true);
});

test("the scan allowance is checked ahead of the spend cap, so the tighter refusal is reported", () => {
  const { ledger } = fixture({ DASHBOARD_SPEND_CAP_USD: "0.0001", DASHBOARD_MAX_SCANS_PER_HOUR: "1" });
  ledger.record(1500);
  expect(ledger.refuse(1500)).toMatchObject({ reason: "scan_rate_1h" });
});

test("a purchase with an unreadable price still counts as a scan, so it is not free of every limit", () => {
  const { ledger } = fixture({ DASHBOARD_MAX_SCANS_PER_HOUR: "2" });
  ledger.record(Number.NaN);
  ledger.record(-5);
  expect(ledger.snapshot().spentMicroUsd).toBe(0);
  expect(ledger.snapshot().scansLastHour).toBe(2);
  expect(ledger.canSpend(1500)).toBe(false);
});

test("the snapshot reports what the page shows: spent, cap, window start and the scan count", () => {
  const { ledger, advance, at } = fixture({ DASHBOARD_SPEND_CAP_USD: "0.50", DASHBOARD_MAX_SCANS_PER_HOUR: "7" });
  // With nothing recorded the window starts now, so "spent today" reads 0 of the cap.
  expect(ledger.snapshot()).toEqual({
    spentMicroUsd: 0,
    capMicroUsd: 500_000,
    windowStartedAt: at(),
    scansLastHour: 0,
    maxScansPerHour: 7,
  });

  const first = at();
  ledger.record(1500);
  advance(60_000);
  ledger.record(2000);
  expect(ledger.snapshot()).toEqual({
    spentMicroUsd: 3500,
    capMicroUsd: 500_000,
    // The oldest purchase still counted, which is what the window is measured from.
    windowStartedAt: first,
    scansLastHour: 2,
    maxScansPerHour: 7,
  });
});

test("reset forgets every purchase, and entries are pruned rather than accumulating forever", () => {
  const { ledger, advance } = fixture({ DASHBOARD_MAX_SCANS_PER_HOUR: "1000" });
  for (let i = 0; i < 100; i++) ledger.record(10);
  expect(ledger.snapshot().scansLastHour).toBe(100);
  advance(SPEND_WINDOW_MS + 1);
  // One call past the window prunes the lot; nothing from before is counted again.
  ledger.record(10);
  expect(ledger.snapshot()).toMatchObject({ spentMicroUsd: 10, scansLastHour: 1 });
  ledger.reset();
  expect(ledger.snapshot().spentMicroUsd).toBe(0);
});
