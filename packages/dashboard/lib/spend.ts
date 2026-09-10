/**
 * Aggregate spending limits for `POST /api/scan`, the one route in this app that moves
 * money.
 *
 * `lib/ratelimit.ts` caps how *often* one client may buy, and `lib/scan.ts` caps what *one*
 * purchase may cost. Neither bounds the total: the per-client limiter keys on a header a
 * direct caller can set to anything (so N forged values buy N scans per window), and the
 * per-scan ceiling is happy to be paid a hundred times. This module is the missing
 * aggregate — a rolling 24-hour spend cap and a global hourly scan count, both applied to
 * every purchase regardless of who asked, so the worst case for the operator's wallet is
 * bounded by configuration rather than by how hard someone tries.
 *
 * In-process and therefore per-instance and reset by a restart, the same caveat the rate
 * limiter carries. It is a budget, not an accounting system: it bounds a demo deployment's
 * exposure, and a deployment that needs a real one should not be funding purchases from an
 * environment variable.
 */

/** Rolling spend window: 24 hours, per spec §13.2's "capped" purchase flow. */
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Rolling window for the scan count. */
export const SCAN_WINDOW_MS = 60 * 60 * 1000;
/** Default aggregate cap across all callers, in USD. */
export const DEFAULT_SPEND_CAP_USD = "1.00";
/** Default global scan allowance per hour, across all callers. */
export const DEFAULT_MAX_SCANS_PER_HOUR = 20;

/** USDC has six decimals, so integer micro-USD is exact for every amount handled here. */
const MICRO_PER_USD = 1_000_000;

export const usdToMicro = (usd: string): number => Math.round(Number(usd) * MICRO_PER_USD);
export const microToUsd = (micro: number): string => (micro / MICRO_PER_USD).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

export type SpendRefusal =
  | { reason: "spend_cap_24h"; spentUsd: string; wouldSpendUsd: string; capUsd: string }
  | { reason: "scan_rate_1h"; scansLastHour: number; maxScansPerHour: number };

export type SpendSnapshot = {
  spentMicroUsd: number;
  capMicroUsd: number;
  /** Epoch ms the current window effectively starts at: the oldest purchase still counted,
   * or "now" when nothing is counted, which is what "spent today" is measured from. */
  windowStartedAt: number;
  scansLastHour: number;
  maxScansPerHour: number;
};

type Entry = { at: number; microUsd: number };

/**
 * Reads the two limits out of an environment. An unparseable or non-positive value is a
 * configuration error, so it falls back to the documented default rather than to "no
 * limit" — the failure mode of a typo must not be an uncapped wallet.
 */
export function limitsFrom(env: Record<string, string | undefined>): { capMicroUsd: number; maxScansPerHour: number } {
  const rawCap = env.DASHBOARD_SPEND_CAP_USD?.trim();
  const cap = rawCap ? usdToMicro(rawCap) : NaN;
  const rawScans = env.DASHBOARD_MAX_SCANS_PER_HOUR?.trim();
  const scans = rawScans ? Number(rawScans) : NaN;
  return {
    capMicroUsd: Number.isFinite(cap) && cap > 0 ? cap : usdToMicro(DEFAULT_SPEND_CAP_USD),
    maxScansPerHour: Number.isInteger(scans) && scans > 0 ? scans : DEFAULT_MAX_SCANS_PER_HOUR,
  };
}

export class SpendLedger {
  private entries: Entry[] = [];
  private readonly capMicroUsd: number;
  private readonly maxScansPerHour: number;
  private readonly now: () => number;

  /**
   * @param env read once for `DASHBOARD_SPEND_CAP_USD` and `DASHBOARD_MAX_SCANS_PER_HOUR`.
   * @param now injectable clock, so tests advance time instead of sleeping.
   */
  constructor(env: Record<string, string | undefined> = process.env, now: () => number = Date.now) {
    const limits = limitsFrom(env);
    this.capMicroUsd = limits.capMicroUsd;
    this.maxScansPerHour = limits.maxScansPerHour;
    this.now = now;
  }

  /** Drops purchases that have aged out of the longer of the two windows. */
  private prune(t: number): void {
    const cutoff = t - Math.max(SPEND_WINDOW_MS, SCAN_WINDOW_MS);
    if (this.entries.length > 0 && this.entries[0].at > cutoff) return;
    this.entries = this.entries.filter((e) => e.at > cutoff);
  }

  private spentMicroUsd(t: number): number {
    const cutoff = t - SPEND_WINDOW_MS;
    return this.entries.reduce((sum, e) => (e.at > cutoff ? sum + e.microUsd : sum), 0);
  }

  private scansLastHour(t: number): number {
    const cutoff = t - SCAN_WINDOW_MS;
    return this.entries.reduce((n, e) => (e.at > cutoff ? n + 1 : n), 0);
  }

  /**
   * Why a purchase of `microUsd` is refused, or null when it is allowed. Checked *before*
   * paying; `record` is called after, with what was actually spent.
   *
   * The spend cap is inclusive: a purchase that lands exactly on the cap is allowed, and
   * the next one is not. The scan count is the same — the Nth scan of the hour is allowed,
   * the N+1th is not.
   */
  refuse(microUsd: number): SpendRefusal | null {
    const t = this.now();
    this.prune(t);
    const scans = this.scansLastHour(t);
    if (scans >= this.maxScansPerHour) {
      return { reason: "scan_rate_1h", scansLastHour: scans, maxScansPerHour: this.maxScansPerHour };
    }
    const spent = this.spentMicroUsd(t);
    const amount = Number.isFinite(microUsd) && microUsd > 0 ? microUsd : 0;
    if (spent + amount > this.capMicroUsd) {
      return {
        reason: "spend_cap_24h",
        spentUsd: microToUsd(spent),
        wouldSpendUsd: microToUsd(amount),
        capUsd: microToUsd(this.capMicroUsd),
      };
    }
    return null;
  }

  /** The boolean form of `refuse`, for callers that do not need the reason. */
  canSpend(microUsd: number): boolean {
    return this.refuse(microUsd) === null;
  }

  /**
   * Records a completed purchase. Called after the payment, with the price the receipt
   * states where one is available, so the ledger tracks money that actually moved.
   *
   * A purchase whose price could not be read still records a zero-cost *scan*, because the
   * hourly scan count is the limit that matters when the price is unknown — a stream of
   * unpriceable purchases must not be free of every limit.
   */
  record(microUsd: number): void {
    const t = this.now();
    this.prune(t);
    this.entries.push({ at: t, microUsd: Number.isFinite(microUsd) && microUsd > 0 ? microUsd : 0 });
  }

  /** What has been spent in the current window, and against what limits. */
  snapshot(): SpendSnapshot {
    const t = this.now();
    this.prune(t);
    const inWindow = this.entries.filter((e) => e.at > t - SPEND_WINDOW_MS);
    return {
      spentMicroUsd: inWindow.reduce((sum, e) => sum + e.microUsd, 0),
      capMicroUsd: this.capMicroUsd,
      windowStartedAt: inWindow.length > 0 ? inWindow[0].at : t,
      scansLastHour: this.scansLastHour(t),
      maxScansPerHour: this.maxScansPerHour,
    };
  }

  /** Test helper: forget every recorded purchase. */
  reset(): void {
    this.entries = [];
  }
}

/**
 * Process-wide ledger used by `POST /api/scan`. Constructed lazily on first use, not at
 * module load, so the limits reflect the environment the server is actually running with
 * (Next.js evaluates route modules before some deployment environments are fully
 * populated, and a test that sets the variables can still get a ledger that sees them).
 */
let shared: SpendLedger | null = null;
export function scanSpendLedger(): SpendLedger {
  if (!shared) shared = new SpendLedger();
  return shared;
}
