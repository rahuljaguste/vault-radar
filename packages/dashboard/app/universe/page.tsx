import Link from "next/link";
import { listRuns, getRun } from "@/lib/runs";
import { buildVaultRows } from "@/lib/universe";
import { Id } from "@/app/components/Id";
import { Sparkline } from "@/app/components/Sparkline";
import { ScoreBar, VerdictBadge, type Verdict } from "@/app/components/Verdict";
import { compactFlag, formatFlag } from "@/lib/flags";
import { explorerTxUrl } from "@/lib/explorer";
import { VERDICT_MEANING } from "@/lib/verdict";

export const metadata = { title: "VaultRadar — vault ranking" };

/** Sparkline tones, which say `absent` where the verdict vocabulary says `unavailable`. */
const toneOf = (v: Verdict) => (v === "unavailable" ? "absent" : v);

/**
 * Which explorer a citation's transaction belongs on.
 *
 * The rail is a property of the request, not of the decision, and a run can hold requests on
 * both rails — so the transaction id's own shape is the more reliable discriminator than
 * whichever rail the run happened to record first. Hedera ids are `0.0.x@seconds.nanos`;
 * Arc's are `0x…`.
 */
const explorerFor = (txId: string) => explorerTxUrl(txId.includes("@") ? "hedera" : "arc", txId);

/** A percentage, or a dash when it cannot be computed. Never a stand-in zero. */
function Pct({ value }: { value: number | null }) {
  if (value === null) return <span className="faint">—</span>;
  return (
    <span className={value < 0 ? "error" : "ok"}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

/**
 * Every vault in one paid scan, ranked worst first.
 *
 * This replaced a three.js scatter of the same run. The scatter plotted a week's change
 * against a day's against a risk score, and the score is zero for every vault that is not
 * flagged — so the third dimension was flat, a hundred points overlapped into blobs, and the
 * axes carried no ticks, which left nothing readable in the picture. Ranked, the two vaults
 * that actually tripped a threshold in this run are the first two rows, which is the answer
 * to the question a buyer has.
 *
 * Reads a stored run rather than the service, so the page shows a real purchase rather than
 * a live query nobody was charged for. `?run=<id>` picks a specific one; without it, the run
 * with the most scored vaults wins, because a ranking of two vaults is not a ranking.
 */
export default async function UniversePage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run: wanted } = await searchParams;
  const summaries = await listRuns();

  // Not simply the newest run (usually a one-vault scan) and not simply the biggest: a scan
  // whose vaults all came back `unavailable` has plenty of verdicts and nothing to rank.
  // Ranked by how many vaults were actually scored, newest first among equals, which picks
  // the 100-vault scan over the single-vault ones and the fresh scan over the stale one.
  let runId = wanted ?? null;
  if (!runId) {
    let bestScored = -1;
    for (const s of summaries) {
      const r = await getRun(s.id);
      if (!r) continue;
      const vs = r.requests.flatMap((q) => q.verdicts);
      const scored = vs.filter((v) => v.verdict !== "unavailable" && (v.history?.length ?? 0) > 1).length;
      // A run with nothing scored is still better than no run at all, so the floor is the
      // total verdict count rather than zero.
      const rank = scored > 0 ? scored * 1000 : vs.length;
      if (rank > bestScored) {
        bestScored = rank;
        runId = s.id;
      }
    }
  }

  const run = runId ? await getRun(runId) : null;
  const rows = run ? buildVaultRows(run.requests.flatMap((q) => q.verdicts), run.decisions) : [];
  const refused = rows.filter((r) => r.verdict === "unavailable").length;

  return (
    <>
      <section className="hero">
        <h1>Vault ranking</h1>
        <p className="lede">
          Every vault in one paid scan, worst score first, with the price series each verdict was computed from. Open a
          row for the flags behind the score, the agent&rsquo;s decision, and the on-chain evidence it rests on.
        </p>
        <div className="row">
          <span className="pill">{rows.length} vaults</span>
          {refused > 0 && <span className="pill">{refused} refused as stale</span>}
          {run && (
            <span className="pill">
              run <Link href={`/runs/${encodeURIComponent(run.id)}`}>{run.id}</Link>
            </span>
          )}
          {summaries.length > 1 && <span className="faint">{summaries.length} runs recorded</span>}
        </div>
      </section>

      {/* The four words are this project's own, and `ok` at score 0 against `no data` at score 0
          was the single most confusing thing on the page — they are opposite findings that
          printed identically. So the definitions are on the page, not only in a tooltip. */}
      <section className="stack tight">
        <h3>What the verdicts mean</h3>
        <dl className="kv">
          <dt>
            <VerdictBadge verdict="ok" />
          </dt>
          <dd>{VERDICT_MEANING.ok}</dd>
          <dt>
            <VerdictBadge verdict="watch" />
          </dt>
          <dd>{VERDICT_MEANING.watch}</dd>
          <dt>
            <VerdictBadge verdict="alert" />
          </dt>
          <dd>{VERDICT_MEANING.alert}</dd>
          <dt>
            <VerdictBadge verdict="unavailable" />
          </dt>
          <dd>{VERDICT_MEANING.unavailable}</dd>
        </dl>
      </section>

      {!run ? (
        <p className="error">No runs recorded yet. Buy a scan from the portfolio page first.</p>
      ) : rows.length === 0 ? (
        <p className="error">This run recorded no verdicts for any vault.</p>
      ) : (
        <section className="stack">
          <div className="vaults">
            <div className="headline" aria-hidden="true">
              <span>Score</span>
              <span>Vault</span>
              <span>Verdict</span>
              <span>Flags</span>
              <span>8-day price</span>
            </div>
            {rows.map((r) => (
              <details key={r.vaultId}>
                <summary>
                  <span>
                    <ScoreBar score={r.score} verdict={r.verdict} />
                  </span>
                  <span>
                    <Id value={r.vaultId} head={10} tail={4} />
                  </span>
                  <span>
                    <VerdictBadge verdict={r.verdict} />
                  </span>
                  <span className="flagcell">
                    {r.flags.length === 0 ? (
                      <span className="faint">—</span>
                    ) : (
                      r.flags.map((f) => (
                        // The cell is short by design; the sentence behind it is a `title`,
                        // and the detail panel below prints it in full.
                        <span className="pill" key={`${f.name}-${f.window}`} title={formatFlag(f)}>
                          {compactFlag(f)}
                        </span>
                      ))
                    )}
                  </span>
                  <span>
                    {r.series.length >= 2 ? (
                      <Sparkline
                        points={r.series}
                        tone={toneOf(r.verdict)}
                        height={30}
                        label={`Share price for ${r.vaultId} across ${r.series.length} observations.`}
                      />
                    ) : (
                      <span className="faint">no series</span>
                    )}
                  </span>
                </summary>

                <div className="detail">
                  {r.series.length >= 2 && (
                    <Sparkline
                      points={r.series}
                      tone={toneOf(r.verdict)}
                      height={140}
                      label={`Full share-price series for ${r.vaultId}, ${r.series.length} observations from the scan.`}
                    />
                  )}
                  <dl className="kv">
                    <dt>Vault</dt>
                    <dd className="mono">{r.vaultId}</dd>
                    <dt>Verdict</dt>
                    <dd>
                      <VerdictBadge verdict={r.verdict} /> <span className="faint">score {r.score} / 100</span>
                    </dd>
                    <dt>7-day change</dt>
                    <dd>
                      <Pct value={r.change7d} />
                    </dd>
                    <dt>24-hour change</dt>
                    <dd>
                      <Pct value={r.change24h} />
                    </dd>
                    <dt>Flags</dt>
                    <dd>
                      {r.flags.length === 0 ? (
                        <span className="faint">none</span>
                      ) : (
                        <ul className="flaglist">
                          {r.flags.map((f) => (
                            <li key={`${f.name}-${f.window}`}>{formatFlag(f)}</li>
                          ))}
                        </ul>
                      )}
                    </dd>
                    {r.reason && (
                      <>
                        <dt>Decision</dt>
                        <dd>
                          <strong>{r.action}</strong> — {r.reason}
                        </dd>
                      </>
                    )}
                    {r.citation ? (
                      <>
                        <dt>Read from</dt>
                        <dd className="mono">
                          {r.citation.source} at block {r.citation.block}
                        </dd>
                        <dt>Paid by</dt>
                        <dd>
                          {r.citation.txId ? (
                            <a href={explorerFor(r.citation.txId)} className="mono">
                              {r.citation.txId}
                            </a>
                          ) : (
                            <span className="faint">no transaction recorded</span>
                          )}
                        </dd>
                        <dt>Receipt</dt>
                        <dd>
                          <Id value={r.citation.receiptHash} head={12} tail={6} />
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt>Evidence</dt>
                        <dd className="faint">this run recorded no decision for this vault</dd>
                      </>
                    )}
                  </dl>
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
