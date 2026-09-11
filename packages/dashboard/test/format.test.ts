import { expect, test } from "bun:test";
import { epochUtc } from "../lib/format";

test("epochUtc renders Unix seconds as a readable UTC instant", () => {
  expect(epochUtc("1789034587")).toBe("2026-09-10T10:03:07Z");
  expect(epochUtc(1789034587)).toBe("2026-09-10T10:03:07Z");
});

test("epochUtc drops a zero millisecond field rather than printing .000Z", () => {
  expect(epochUtc("1789034587")).not.toContain(".000");
});

test("epochUtc shows a dash for a value the service did not report", () => {
  for (const empty of [null, undefined, ""]) expect(epochUtc(empty)).toBe("-");
});

// A value the service one day formats differently should stay legible on the page. The
// alternative — new Date(NaN) — renders as "Invalid Date", which tells an operator less
// than the raw value does.
test("epochUtc passes through anything that is not a plausible epoch", () => {
  expect(epochUtc("2026-09-10T10:03:07Z")).toBe("2026-09-10T10:03:07Z");
  expect(epochUtc("not a time")).toBe("not a time");
  expect(epochUtc("0")).toBe("0");
  expect(epochUtc("-5")).toBe("-5");
});

// The page is server-rendered and then hydrated. A local-time format would produce
// different text on each side whenever the two disagree about the zone, which React
// reports as a hydration mismatch.
test("epochUtc does not depend on the host time zone", () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "Asia/Kolkata";
    const kolkata = epochUtc("1789034587");
    process.env.TZ = "UTC";
    expect(epochUtc("1789034587")).toBe(kolkata);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
