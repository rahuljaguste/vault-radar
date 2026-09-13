import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { VERDICT_MEANING, VERDICT_WORDS, scoreLabel, verdictOf, type Verdict } from "@/lib/verdict";

/**
 * The verdict vocabulary lives in `lib/verdict.ts` and is re-exported here, so a page can keep
 * importing the words from the component it renders them with.
 */
export { verdictOf };
export type { Verdict };

/** Badge looks per verdict: tinted, so the four words are told apart at a glance. */
const TONES: Record<string, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  watch: "border-warn/40 bg-warn/10 text-warn",
  alert: "border-destructive/40 bg-destructive/10 text-destructive",
  unavailable: "border-border bg-secondary text-muted-foreground",
};

/** Any of this product's states (verdicts, statuses, actions) as a tinted Badge. */
export function ToneBadge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <Badge variant="outline" className={TONES[tone] ?? TONES.unavailable} title={title}>
      {children}
    </Badge>
  );
}

/**
 * A verdict as a badge.
 *
 * The `title` defaults to what the verdict actually claims, because the four words are this
 * project's own and a bare `ok` does not tell a reader that it means "nothing was flagged"
 * rather than "this is safe". A caller passing its own `title` (a flag, say) overrides it.
 */
export function VerdictBadge({ verdict, title }: { verdict: Verdict; title?: string }): ReactNode {
  const tone = verdict === "unavailable" ? "unavailable" : verdict;
  return (
    <ToneBadge tone={tone} title={title ?? VERDICT_MEANING[verdict]}>
      {VERDICT_WORDS[verdict]}
    </ToneBadge>
  );
}

/**
 * A 0-100 score as a bar, or a dash when there is no score to show.
 *
 * A number alone ("82") makes the reader recall the thresholds before they know whether to
 * care; the bar's length and colour answer that on sight, and the number stays for anyone
 * comparing two vaults over time.
 *
 * `unavailable` renders no bar at all. It carries a score of 0 for the same mechanical
 * reason every unremarkable vault does — nothing was added to it — but the two mean opposite
 * things, and a row of empty bars with a `0` in it read as a hundred vaults scoring zero
 * when fifteen of them had not been assessed.
 */
export function ScoreBar({ score, verdict }: { score: number; verdict?: Verdict }): ReactNode {
  const tone = verdict ?? verdictOf(score);
  if (tone === "unavailable") {
    return (
      <span className="score absent" title={VERDICT_MEANING.unavailable}>
        {scoreLabel(score, tone)}
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, score));
  return (
    <span className={`score ${tone}`} title={`${score} / 100, ${VERDICT_MEANING[tone]}`}>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span>{scoreLabel(score, tone)}</span>
    </span>
  );
}
