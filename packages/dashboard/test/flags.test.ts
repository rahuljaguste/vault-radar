import { expect, test } from "bun:test";
import { compactFlag, flagPercent } from "../lib/flags";

test("a ratio flag reads as its name and its percentage", () => {
  // The engine writes ratios. 0.098392 is a 9.8% drawdown, and naming it in the cell keeps
  // the number from being a bare percentage with no object.
  expect(compactFlag({ name: "share_price_drawdown_7d", value: "0.098392", threshold: "0.050000", window: "7d" })).toBe(
    "share price drawdown 7d 9.8%",
  );
  expect(compactFlag({ name: "tvl_outflow_24h", value: "0.372054", threshold: "0.200000", window: "24h" })).toBe(
    "tvl outflow 24h 37.2%",
  );
});

test("a flag that is not a ratio reads as its name alone", () => {
  // `stale_data` carries the words "stale" and "fresh", not numbers. Rendering it as a
  // percentage would invent a figure, and rendering "stale data: stale" is what the full
  // sentence is for.
  expect(compactFlag({ name: "stale_data", value: "stale", threshold: "fresh", window: "now" })).toBe("stale data");
});

test("a percentage is not scaled twice", () => {
  // The committed demo fixture was written by hand with percentages where the engine writes
  // ratios. Both must read correctly, or a 12.4% drawdown renders as 1240%.
  expect(compactFlag({ name: "share_price_drop_1d", value: "-12.4", threshold: "5", window: "1d" })).toBe(
    "share price drop 1d -12.4%",
  );
  expect(flagPercent("-12.4")).toBeCloseTo(-12.4, 6);
  expect(flagPercent("0.098392")).toBeCloseTo(9.8392, 6);
});

test("a flag value that is not a number does not render as NaN", () => {
  expect(compactFlag({ name: "tvl_outflow_24h", value: "unknown", threshold: "0.2", window: "24h" })).toBe(
    "tvl outflow 24h 0.0%",
  );
});
