import Link from "next/link";
import { listRuns, getRun } from "@/lib/runs";
import { RiskUniverse, type UniversePoint } from "@/app/components/RiskUniverse";
import { Id } from "@/app/components/Id";
import { VerdictBadge } from "@/app/components/Verdict";

/** A vault needs at least this much series to have a week's change worth plotting. */
const MIN_POINTS = 2;
const WEEK_S = 7 * 86400;
const DAY_S = 86400;

export const metadata = { title: "VaultRadar — risk universe" };

/**
 * The vault universe: every scored vault from one run, placed by how far its price has moved
 * over a week and a day, coloured by its verdict.
 *
 * Reads a stored run rather than the service, so the page shows a real purchase rather than
 * a live query the service never charged for. `?run=<id>` picks a specific one; without it,
 * the largest run in the directory is used, because a universe of two points is not a
 * universe.
 */
export default async function UniversePage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run: wanted } = await searchParams;
  const summaries = await listRuns();

  // Picking the biggest run rather than the newest: a 100-vault scan is worth looking at and
  // a one-vault scan is not, and the newest run is usually the small one.
  let runId = wanted ?? null;
  if (!runId) {
    let best = 0;
    for (const s of summaries) {
      const r = await getRun(s.id);
      const n = r?.requests.flatMap((q) => q.verdicts).length ?? 0;
      if (n > best) {
        best = n;
        runId = s.id;
      }
    }
  }

  const run = runId ? await getRun(runId) : null;
  const verdicts = run?.requests.flatMap((q) => q.verdicts) ?? [];
  const points: UniversePoint[] = verdicts
    .map((v) => {
      const h = v.history ?? [];
      if (h.length < MIN_POINTS) return null;
      const last = h[h.length - 1];
      const at = (seconds: number) => {
        const cutoff = last.t - seconds;
        const older = [...h].reverse().find((p) => p.t <= cutoff);
        return older ?? h[0];
      };
      const pct = (ref: { v: number }) => (ref.v === 0 ? 0 : ((last.v - ref.v) / ref.v) * 100);
      return {
        id: v.vaultId,
        score: v.score,
        verdict: v.verdict,
        change7d: pct(at(WEEK_S)),
        change24h: pct(at(DAY_S)),
      };
    })
    .filter((p): p is UniversePoint => p !== null);

  return (
    <>
      <section className="hero">
        <h1>Risk universe</h1>
        <p className="lede">
          Every vault in one paid scan, placed by how far its price has moved over a week and over a day, coloured by
          the verdict the risk engine returned. Drag to orbit; click a vault to identify it.
        </p>
        <div className="row">
          <span className="pill">
            {points.length} of {verdicts.length} vaults plotted
          </span>
          {run && (
            <span className="pill">
              run{" "}
              <Link href={`/runs/${encodeURIComponent(run.id)}`}>
                {run.id}
              </Link>
            </span>
          )}
          {summaries.length > 1 && <span className="faint">{summaries.length} runs recorded</span>}
        </div>
      </section>

      {!run ? (
        <p className="error">No runs recorded yet. Buy a scan from the portfolio page first.</p>
      ) : points.length === 0 ? (
        <p className="error">
          This run recorded no price series — it predates the series being saved, or every vault was refused as stale.
        </p>
      ) : (
        <section className="stack">
          <RiskUniverse points={points} />
          {/* The same data as a table. Not a fallback for a missing WebGL context alone —
              it is also the only version a screen reader, a text browser or a test can read,
              so it renders unconditionally rather than behind a feature check. */}
          <details>
            <summary className="faint">The same vaults as a table</summary>
            <table>
              <thead>
                <tr>
                  <th>Vault</th>
                  <th className="num">7-day</th>
                  <th className="num">24-hour</th>
                  <th className="num">Score</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {[...points]
                  .sort((a, b) => a.change7d - b.change7d)
                  .map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Id value={p.id} head={10} tail={4} />
                      </td>
                      <td className={`num ${p.change7d < 0 ? "error" : "ok"}`}>
                        {p.change7d >= 0 ? "+" : ""}
                        {p.change7d.toFixed(2)}%
                      </td>
                      <td className={`num ${p.change24h < 0 ? "error" : "ok"}`}>
                        {p.change24h >= 0 ? "+" : ""}
                        {p.change24h.toFixed(2)}%
                      </td>
                      <td className="num">{p.score}</td>
                      <td>
                        <VerdictBadge verdict={p.verdict} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </section>
      )}
    </>
  );
}
