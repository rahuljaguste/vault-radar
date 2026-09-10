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
 * `env` is injectable so tests can set the flag without touching `process.env`.
 */
export function clientKey(req: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.TRUST_PROXY?.trim() !== "1") return "unknown";
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

/** Process-wide limiter used by `POST /api/scan`. */
export const scanLimiter = new RateLimiter();
