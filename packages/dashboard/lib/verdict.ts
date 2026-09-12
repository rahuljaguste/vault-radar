/**
 * The verdict vocabulary, in one place.
 *
 * These four words are this project's own, not an industry standard. `watch` is borrowed from
 * financial supervision, where a watch list means heightened observation rather than a
 * conclusion, and `alert`/`ok` are generic severity words — but the bands behind them
 * (20 and 50) are ours, decided in `packages/core/src/risk.ts`, and nothing about the words
 * themselves tells a reader that. So every state carries a sentence saying what it means, and
 * the UI is expected to show it rather than leave a bare `ok` to be interpreted.
 *
 * `Verdict` is redeclared rather than imported from core for the reason the component used to
 * give: the dashboard renders *stored* runs, and a run recorded last week should read as the
 * verdict it had, not as whatever today's thresholds would say.
 */

export type Verdict = "ok" | "watch" | "alert" | "unavailable";

/** Risk score at or above which `risk.ts` calls it an alert, and below which it is ok. */
const ALERT_AT = 50;
const WATCH_AT = 20;

/**
 * The verdict a score maps to, matching `risk.ts`'s own thresholds. Only for a bare score —
 * everywhere else the recorded verdict is preferred.
 */
export function verdictOf(score: number): Verdict {
  return score >= ALERT_AT ? "alert" : score >= WATCH_AT ? "watch" : "ok";
}

/** The word shown for each verdict. `unavailable` is a refusal, not a mild `ok`. */
export const VERDICT_WORDS: Record<Verdict, string> = {
  ok: "ok",
  watch: "watch",
  alert: "alert",
  unavailable: "no data",
};

/**
 * What each verdict actually claims, in the engine's own terms.
 *
 * The score is a penalty total that starts at zero and only rises when a threshold is
 * crossed (`risk.ts`), which is why most vaults read `ok` with a score of 0 and why `ok`
 * cannot be read as "this vault is safe".
 */
export const VERDICT_MEANING: Record<Verdict, string> = {
  ok: "Score 0–19: nothing this engine watches for crossed a threshold — no sharp price drop over an hour, a day or a week, no heavy outflow, no deposit limit reached. It means nothing was flagged, not that the vault is safe.",
  watch: "Score 20–49: at least one threshold was crossed, so the vault is worth a look. The agent still holds; it is not an instruction to exit.",
  alert: "Score 50 or more: several thresholds were crossed at once, or one severe one. The agent's policy withdraws on this.",
  unavailable:
    "No verdict was computed: the data source was stale, or the share price could not be read. This is a refusal to answer, not a low score — nothing about the vault was assessed.",
};

/**
 * The score cell's text. `unavailable` gets a dash, never a zero.
 *
 * Both states carry a score of 0 — `ok` because nothing was penalised, `unavailable` because
 * nothing was assessed — and printing `0` for both put "we looked and saw nothing" next to
 * "we could not look" in the same column, which is unreadable.
 */
export function scoreLabel(score: number, verdict: Verdict): string {
  return verdict === "unavailable" ? "—" : String(score);
}
