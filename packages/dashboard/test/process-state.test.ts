import { afterEach, expect, test } from "bun:test";
import { RateLimiter, scanLimiter } from "../lib/ratelimit";
import { SpendLedger, scanSpendLedger } from "../lib/spend";
import { resetProcessStateForTests, sharedInstance } from "../lib/process-state";

/**
 * The shared instances must be *one* object each for the whole app.
 *
 * A module-level `const` is not enough under Next.js: a route handler and a server component
 * are compiled into different bundles, each with its own copy of `lib/spend.ts`, so
 * `POST /api/scan` enforced one ledger while `/portfolio` displayed the snapshot of another —
 * showing no spend against a cap that had been reached. A development server's hot reload
 * re-evaluates modules for the same reason, which would silently reset both counters.
 *
 * A second module graph cannot be created inside one bun test process (imports of the same
 * path are cached), so these drive the property that actually matters: the accessor finds an
 * existing instance rather than constructing a parallel one, and the instance lives on
 * `globalThis` where any bundle's copy of the module will look for it.
 */

afterEach(() => {
  resetProcessStateForTests();
});

test("sharedInstance constructs once and never calls a later factory", () => {
  resetProcessStateForTests();
  const first = new SpendLedger({});
  const second = new SpendLedger({});
  expect(first).not.toBe(second);

  let factoryCalls = 0;
  const got = sharedInstance("spendLedger", () => {
    factoryCalls++;
    return first;
  });
  expect(got).toBe(first);
  expect(factoryCalls).toBe(1);

  // A second module graph evaluating its own copy of `lib/spend.ts` would call the accessor
  // with its own `new SpendLedger()` factory. It must get the first graph's object, and its
  // factory must never run — otherwise two ledgers exist and only one of them is enforced.
  const again = sharedInstance("spendLedger", () => {
    factoryCalls++;
    return second;
  });
  expect(again).toBe(first);
  expect(again).not.toBe(second);
  expect(factoryCalls).toBe(1);
});

test("the instance is reachable through the global registry, not a module-local variable", () => {
  resetProcessStateForTests();
  const ledger = scanSpendLedger();
  // `Symbol.for` is the cross-realm registry, so a differently-compiled copy of the module
  // resolves to this same slot rather than to a symbol of its own.
  const holder = globalThis as { [key: symbol]: unknown };
  const state = holder[Symbol.for("vaultradar.dashboard.processState")] as { spendLedger?: SpendLedger };
  expect(state).toBeDefined();
  expect(state.spendLedger).toBe(ledger);
});

test("two calls to scanSpendLedger resolve to the same object, and state carries across them", () => {
  resetProcessStateForTests();
  const a = scanSpendLedger();
  const b = scanSpendLedger();
  expect(a).toBe(b);

  // Not just reference equality: a purchase booked through one call is visible through the
  // other, which is the thing `/portfolio` depends on.
  a.record(1500);
  expect(b.snapshot().spentMicroUsd).toBe(1500);
  expect(scanSpendLedger().snapshot().scansLastHour).toBe(1);
});

test("two calls to scanLimiter resolve to the same object, so the window is not reset per caller", () => {
  resetProcessStateForTests();
  const a = scanLimiter();
  expect(a).toBeInstanceOf(RateLimiter);
  expect(scanLimiter()).toBe(a);

  expect(scanLimiter().check("probe").allowed).toBe(true);
  // Would be `true` again if each call built its own limiter — the failure mode a
  // module-level instance has on every hot reload and in every separate bundle.
  expect(scanLimiter().check("probe").allowed).toBe(false);
});

test("the two shared slots are independent of each other", () => {
  resetProcessStateForTests();
  const ledger = scanSpendLedger();
  const limiter = scanLimiter();
  expect(ledger).not.toBe(limiter as unknown as SpendLedger);
  expect(scanSpendLedger()).toBe(ledger);
  expect(scanLimiter()).toBe(limiter);
});

test("resetProcessStateForTests clears the registry, so first-use construction is observable", () => {
  const before = scanSpendLedger();
  resetProcessStateForTests();
  const after = scanSpendLedger();
  expect(after).not.toBe(before);
});
