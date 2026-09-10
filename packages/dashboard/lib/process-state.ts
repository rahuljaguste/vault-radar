import type { RateLimiter } from "./ratelimit";
import type { SpendLedger } from "./spend";

/**
 * The handful of objects that must be the *same instance* for every part of this app, held
 * on `globalThis` under one symbol key.
 *
 * A module-level `const` is not enough under Next.js. A route handler and a server component
 * are compiled into different bundles — different module graphs, each with its own copy of
 * `lib/spend.ts` — so `POST /api/scan` was enforcing one `SpendLedger` while `/portfolio`
 * rendered the snapshot of another. The page showed "spent today: 0.00" next to a cap that
 * had in fact been reached, which is worse than showing nothing: it is a spending figure
 * that is wrong in the reassuring direction. A development server's hot reload re-evaluates
 * modules for the same reason and would have reset the counters silently.
 *
 * `Symbol.for` puts the key in the cross-realm registry, so every bundle that evaluates this
 * module resolves to the same slot rather than to a symbol of its own. The slot's *contents*
 * are typed (`ProcessState`), so a bundle cannot disagree with another about what lives
 * there; only the lookup is dynamic.
 *
 * Still per process, and so still per instance if the app is scaled out — see `lib/spend.ts`
 * on what that means for the cap.
 */
export type ProcessState = {
  spendLedger?: SpendLedger;
  scanLimiter?: RateLimiter;
};

const STATE_KEY = Symbol.for("vaultradar.dashboard.processState");

function state(): ProcessState {
  const holder = globalThis as { [key: symbol]: unknown };
  if (!holder[STATE_KEY]) holder[STATE_KEY] = {} as ProcessState;
  return holder[STATE_KEY] as ProcessState;
}

/**
 * The one instance of `key`, constructing it on first use. `create` is not called when an
 * instance already exists, which is the property that matters: a second module graph
 * evaluating its own copy of the calling module finds the first graph's object rather than
 * quietly building a parallel one.
 */
export function sharedInstance<K extends keyof ProcessState>(key: K, create: () => NonNullable<ProcessState[K]>): NonNullable<ProcessState[K]> {
  const store = state();
  if (!store[key]) store[key] = create();
  return store[key] as NonNullable<ProcessState[K]>;
}

/** Test helper: forget every shared instance, so a test can observe first-use construction.
 *  Nothing in the app calls this. */
export function resetProcessStateForTests(): void {
  const holder = globalThis as { [key: symbol]: unknown };
  delete holder[STATE_KEY];
}
