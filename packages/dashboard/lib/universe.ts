import type { Series } from "../app/components/Sparkline";
import type { Verdict } from "../app/components/Verdict";
import type { RunRecord } from "./types";

/**
 * One run's vaults as the ranked table shows them.
 *
 * This replaced a three.js scatter. The scatter was honest about the data and bad at showing
 * it: a hundred vaults is a dense cloud, the third axis was a risk score that is zero for
 * every vault that is not flagged, and the axes carried no ticks, so nothing in the picture
 * could be read off it. A ranked table answers the question a buyer actually has — which of
 * these is worst, and by how much — and a sparkline per row shows the shape the verdict was
 * computed from without needing a chart library or a WebGL context.
 *
 * Kept out of the page component so the ranking, the change arithmetic and the decision
 * join are testable without rendering anything.
 */

type VerdictRecord = RunRecord["requests"][number]["verdicts"][number];
type DecisionRecord = RunRecord["decisions"][number];

export type { DecisionRecord, VerdictRecord };

export type VaultRow = {
  vaultId: string;
  verdict: Verdict;
  score: number;
  flags: VerdictRecord["flags"];
  /** The price points the verdict was computed from, oldest first. Empty when the run
   *  recorded none — which is the normal case for the agent's own runs. */
  series: Series[];
  /** Percent change against the newest price, or null when it cannot be computed at all
   *  (fewer than two points, or a reference price of zero). Never a stand-in zero: a vault
   *  with no series and a vault that moved 0% are different facts. */
  change7d: number | null;
  change24h: number | null;
  action: DecisionRecord["action"] | null;
  reason: string | null;
  citation: DecisionRecord["citations"] | null;
};

const DAY_S = 86400;
const WEEK_S = 7 * DAY_S;

/** A percentage change needs two prices and a non-zero starting one. */
const MIN_POINTS = 2;

/**
 * Percent change from the newest point back to whatever was current `seconds` earlier —
 * the nearest point at or before that cutoff, or the oldest point when the series does not
 * reach back that far (a young vault's "7-day" change is really its whole life, which is
 * worth showing rather than holding back).
 */
function changeOver(history: Series[], seconds: number): number | null {
  if (history.length < MIN_POINTS) return null;
  const last = history[history.length - 1]!;
  const cutoff = last.t - seconds;
  let ref = history[0]!;
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i]!;
    if (p.t <= cutoff) {
      ref = p;
      break;
    }
  }
  if (ref.v === 0) return null;
  return ((last.v - ref.v) / ref.v) * 100;
}

/**
 * Every vault in a run, worst first, one row each.
 *
 * `unavailable` sorts below every scored vault regardless of score: it is a refusal to answer,
 * not a mild `ok`, and a run where everything was refused must not read as a clean bill of
 * health.
 */
export function buildVaultRows(verdicts: VerdictRecord[], decisions: DecisionRecord[]): VaultRow[] {
  const picked = new Map<string, VerdictRecord>();
  for (const v of verdicts) {
    const seen = picked.get(v.vaultId);
    // A run can hold more than one paid request, and the same vault can be bought in two of
    // them. Two rows for one vault would collide on the React key and read as two holdings,
    // so the more severe reading wins.
    if (!seen || v.score > seen.score) picked.set(v.vaultId, v);
  }

  const byVault = new Map(decisions.map((d) => [d.vaultId, d]));

  const rows = [...picked.values()].map((v): VaultRow => {
    const history = v.history ?? [];
    const decision = byVault.get(v.vaultId) ?? null;
    return {
      vaultId: v.vaultId,
      verdict: v.verdict,
      score: v.score,
      flags: v.flags,
      series: history,
      change7d: changeOver(history, WEEK_S),
      change24h: changeOver(history, DAY_S),
      action: decision?.action ?? null,
      reason: decision?.reason ?? null,
      citation: decision?.citations ?? null,
    };
  });

  const refused = (r: VaultRow) => (r.verdict === "unavailable" ? 1 : 0);
  return rows.sort(
    (a, b) => refused(a) - refused(b) || b.score - a.score || a.vaultId.localeCompare(b.vaultId),
  );
}
