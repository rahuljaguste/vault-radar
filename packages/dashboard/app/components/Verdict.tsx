import type { ReactNode } from "react";

/** The four states a vault can be in, in one place so every page spells them the same. */
export type Verdict = "ok" | "watch" | "alert" | "unavailable";

/** Risk score at or above which `risk.ts` calls it an alert, and below which it is ok. */
const ALERT_AT = 50;
const WATCH_AT = 20;

/**
 * The verdict a score maps to, matching `risk.ts`'s own thresholds. Duplicated here rather
 * than exported from core because the dashboard renders stored runs: a run recorded last
 * week should read as the verdict it *had*, not as whatever today's thresholds would say.
 * The recorded verdict is preferred everywhere; this is only for a bare score.
 */
export function verdictOf(score: number): Verdict {
  return score >= ALERT_AT ? "alert" : score >= WATCH_AT ? "watch" : "ok";
}

/** The word shown for each verdict. `unavailable` is a refusal, not a mild `ok`. */
const WORDS: Record<Verdict, string> = {
  ok: "ok",
  watch: "watch",
  alert: "alert",
  unavailable: "no data",
};

export function VerdictBadge({ verdict, title }: { verdict: Verdict; title?: string }): ReactNode {
  const tone = verdict === "unavailable" ? "unavailable" : verdict;
  return (
    <span className={`badge ${tone}`} title={title}>
      {WORDS[verdict]}
    </span>
  );
}

/**
 * A 0-100 score as a bar. A number alone ("82") makes the reader recall the thresholds
 * before they know whether to care; the bar's length and colour answer that on sight, and
 * the number stays for anyone comparing two vaults over time.
 */
export function ScoreBar({ score, verdict }: { score: number; verdict?: Verdict }): ReactNode {
  const tone = verdict ?? verdictOf(score);
  const pct = Math.max(0, Math.min(100, score));
  return (
    <span className={`score ${tone === "unavailable" ? "absent" : tone}`} title={`${score} / 100`}>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span>{score}</span>
    </span>
  );
}
