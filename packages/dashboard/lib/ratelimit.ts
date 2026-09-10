/**
 * In-memory rate limiter for the one route in this app that spends real money
 * (`POST /api/scan`). One paid scan per client per `WINDOW_MS`.
 *
 * Deliberately not a security boundary: the counters live in the Next.js server
 * process, so they reset on restart and are per-instance if the app is ever
 * scaled out, and the client key is derived from a proxy header that only a
 * trusted proxy makes trustworthy (see `clientKey`). The real spending backstop
 * is the agent policy's per-rail budget, which is enforced server-side on every
 * purchase. This limiter exists to stop an accidental double-click or a trivial
 * loop from draining the operator's testnet USDC.
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
 * The client identity a scan is limited against: the first entry of
 * `x-forwarded-for` (the original client when a trusted proxy such as Vercel
 * sets the header, which is the only deployment this app is documented for),
 * then `x-real-ip`, then a shared `"unknown"` bucket. Falling back to one shared
 * bucket is deliberate: with no usable address, limiting everyone together is
 * safer for the operator's wallet than limiting nobody.
 *
 * A direct caller can forge either header, so this is advisory. See the note at
 * the top of this file for what actually caps spending.
 */
export function clientKey(req: Request): string {
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
