/**
 * In-memory rate limiter for the one route in this app that spends real money
 * (`POST /api/scan`). One paid scan per client per `WINDOW_MS`.
 *
 * Deliberately not a security boundary, and not the spending backstop either. The
 * counters live in the Next.js server process, so they reset on restart and are
 * per-instance if the app is ever scaled out; and the client key can only be as
 * trustworthy as the proxy header it comes from, which is why `clientKey` now
 * requires `TRUST_PROXY=1` before believing one at all.
 *
 * The earlier version of this comment named the agent policy's per-rail budget as
 * "the real spending backstop". That was wrong: the policy budget is a cap on a
 * *single* purchase (`lib/scan.ts` compares one quote against it), so it bounds
 * what one scan costs and says nothing about how many scans are bought. The
 * aggregate limits live in `lib/spend.ts` — a rolling 24-hour spend cap and a
 * global hourly scan count, both checked before every payment. This limiter is
 * what stops an accidental double-click and spreads legitimate use out; the
 * ledger is what bounds the bill.
 */

import { sharedInstance } from "./process-state";

/** One paid scan per client per 30 seconds, per spec §13.2. */
export const WINDOW_MS = 30_000;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly hits = new Map<string, number>();

  /**
   * @param windowMs minimum gap between two allowed calls for the same key.
   * @param now injectable clock, so tests advance time instead of sleeping.
   */
  constructor(
    private readonly windowMs: number = WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records and allows the call, or refuses it with the whole seconds the caller
   * must wait. Expired keys are swept on every call so a long-running process
   * does not accumulate an entry per client address forever.
   */
  check(key: string): RateLimitResult {
    const t = this.now();
    for (const [k, last] of this.hits) {
      if (t - last >= this.windowMs) this.hits.delete(k);
    }
    const last = this.hits.get(key);
    if (last !== undefined && t - last < this.windowMs) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - (t - last)) / 1000)) };
    }
    this.hits.set(key, t);
    return { allowed: true };
  }

  /** Test helper: forget every recorded call. */
  reset(): void {
    this.hits.clear();
  }

  /** Test helper: how many keys are currently being tracked. */
  size(): number {
    return this.hits.size;
  }
}

/**
 * How many proxies in front of this server append to `x-forwarded-for`, and therefore how
 * far from the END of that list the first entry a caller cannot choose sits. One is right
 * for every deployment this app is documented for:
 *
 * - **Fly.io** appends the socket peer address it observed, so a header the client sent as
 *   `1.1.1.1` arrives as `1.1.1.1, <real client>`. The last entry is Fly's.
 * - **Vercel** replaces the header with the client address it observed, so there is one
 *   entry and it is Vercel's.
 *
 * Raise it only when another proxy of your own sits in front of that one, appending as
 * well: with two appending hops the trustworthy entry is two from the end.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** `TRUSTED_PROXY_HOPS` as a positive integer; anything else is a configuration error and
 *  falls back to the default rather than to a position a caller could choose. */
export function trustedProxyHops(env: Record<string, string | undefined>): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_TRUSTED_PROXY_HOPS;
}

/**
 * The client identity a scan is limited against.
 *
 * Both candidate headers — `x-forwarded-for` and `x-real-ip` — are set by a proxy and
 * forgeable by anyone talking to this server directly. Keying on them unconditionally
 * turned the per-client limit into no limit at all: a caller that varies
 * `x-forwarded-for` gets a fresh 30-second window per value, so the limiter counted
 * one scan per request and refused none of them.
 *
 * So they are believed only when `TRUST_PROXY=1` says a proxy is in front of this
 * server and is the thing setting them. Next.js route handlers are given a `Request`,
 * which exposes no socket address, so without that flag there is no per-caller
 * identity available here at all and everyone shares the `"unknown"` bucket — one
 * scan per 30 seconds for the whole deployment. That is intentionally blunt: the
 * aggregate limits in `lib/spend.ts` are what bound total spending, and a shared
 * bucket is safer for the operator's wallet than a key an anonymous caller chooses.
 *
 * Even *with* a trusted proxy, the entry chosen has to be one the caller could not have
 * written. Taking the first entry was wrong on any proxy that appends rather than replaces
 * (Fly.io appends): the client sends `x-forwarded-for: <anything it likes>`, the proxy
 * appends the address it actually saw, and the first entry is the client's invention — so
 * `TRUST_PROXY=1` on Fly still handed out a fresh window per forged value. The entry
 * `TRUSTED_PROXY_HOPS` positions from the END is the one the nearest trusted proxy wrote.
 * A list shorter than the configured hop count cannot have come from that chain, so it
 * yields the shared bucket rather than a guess.
 *
 * `env` is injectable so tests can set the flags without touching `process.env`.
 */
export function clientKey(req: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.TRUST_PROXY?.trim() !== "1") return "unknown";
  const parts = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length > 0) {
    const index = parts.length - trustedProxyHops(env);
    return index >= 0 ? parts[index] : "unknown";
  }
  // No usable `x-forwarded-for` at all: `x-real-ip` is set by the same trusted proxy (and
  // is a single value, so there is no hop to count), then the shared bucket.
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

/**
 * The limiter `POST /api/scan` uses.
 *
 * Held on `globalThis` (see `lib/process-state.ts`) rather than as a module-level instance,
 * for the same reason the spend ledger is: Next.js compiles a route handler and a server
 * component into different bundles, each with its own copy of this module, and a development
 * server's hot reload re-evaluates it — either of which would hand out a fresh limiter with
 * empty counters. A rate limit that resets when a module is re-evaluated is not a rate limit.
 */
export function scanLimiter(): RateLimiter {
  return sharedInstance("scanLimiter", () => new RateLimiter());
}
