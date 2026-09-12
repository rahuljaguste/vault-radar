import { notFound } from "next/navigation";
import { getRun } from "@/lib/runs";
import { fetchReceiptLookup, type ReceiptLookup } from "@/lib/service";
import { explorerTxUrl } from "@/lib/explorer";
import { Id } from "@/app/components/Id";
import { ScoreBar, VerdictBadge } from "@/app/components/Verdict";
import { Sparkline } from "@/app/components/Sparkline";
import { flagPercent, flagLabel } from "@/lib/flags";
import type { RunRecord } from "@/lib/types";

type RequestRecord = RunRecord["requests"][number];
type VerdictRow = RequestRecord["verdicts"][number];

/** `1h`/`24h`/`7d` as the risk engine names its windows, in seconds, for shading a chart. */
const WINDOW_SECONDS: Record<string, number> = { "1h": 3600, "24h": 86400, "7d": 7 * 86400 };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const lookups = await Promise.all(run.requests.map((r) => fetchReceiptLookup(r.receiptHash)));
  const verdicts = run.requests.flatMap((r) => r.verdicts);
  const alerts = verdicts.filter((v) => v.verdict === "alert").length;
  const watching = verdicts.filter((v) => v.verdict === "watch").length;
  const unavailable = verdicts.filter((v) => v.verdict === "unavailable").length;
  const spend = run.requests.reduce((sum, r) => sum + (Number(r.priceUsd) || 0), 0);

  return (
    <>
      <section className="hero">
        <h1>Run {run.id}</h1>
        <p className="lede">
          {run.requests.length} paid {run.requests.length === 1 ? "request" : "requests"} · {verdicts.length}{" "}
          {verdicts.length === 1 ? "vault" : "vaults"} scored · {spend.toFixed(4)} USD spent
        </p>
        <div className="row">
          <span className="pill">started {run.startedAt}</span>
          <span className="pill">policy {run.policy.privacy}</span>
          <span className="pill">max age {run.policy.max_age_seconds}s</span>
          {alerts > 0 && <span className="badge alert">{alerts} alert</span>}
          {watching > 0 && <span className="badge watch">{watching} watch</span>}
          {unavailable > 0 && <span className="badge unavailable">{unavailable} no data</span>}
          {alerts + watching + unavailable === 0 && <span className="badge ok">all clear</span>}
        </div>
      </section>

      <section className="card">
        <h3>Discovery</h3>
        <dl className="kv">
          <dt>Service</dt>
          <dd>
            <span className="mono" title={run.serviceUrl}>
              {run.serviceUrl}
            </span>
          </dd>
          <dt>Card signature</dt>
          <dd className={run.discovery.cardSignatureValid ? "ok" : "error"}>
            {run.discovery.cardSignatureValid ? "valid" : "INVALID"}
          </dd>
          <dt>Published key hash</dt>
          <dd>
            <Id value={run.discovery.pubHash} />
          </dd>
          <dt>On-chain anchor</dt>
          <dd>
            {run.discovery.onChain.length === 0 ? (
              <span className="error">no identity checked</span>
            ) : (
              run.discovery.onChain.map((o) => (
                <span className={`badge ${o.matches === true ? "ok" : o.matches === false ? "alert" : "unavailable"}`} key={o.chainId}>
                  {o.chainId}:{o.agentId} {o.matches === null ? "unread" : o.matches ? "matches" : "MISMATCH"}
                </span>
              ))
            )}
          </dd>
        </dl>
      </section>

      {run.requests.map((req, i) => (
        <RequestSection key={req.receiptHash} req={req} lookup={lookups[i] ?? null} />
      ))}

      <section className="stack">
        <h3>Decisions</h3>
        {run.decisions.length === 0 ? (
          <p className="empty">No decisions recorded.</p>
        ) : (
          <DecisionGrid decisions={run.decisions} run={run} />
        )}
      </section>
    </>
  );
}

/** Which badge/stripe tone an action deserves. `hold` is the only unremarkable one. */
function actionTone(action: string): "ok" | "watch" | "alert" | "unavailable" {
  if (action === "withdraw") return "alert";
  if (action === "rebalance") return "watch";
  if (action === "insufficient data") return "unavailable";
  return "ok";
}

/** Look up which rail a cited receipt was paid on, to pick the right explorer link. Defaults to hedera if not found. */
function railForReceipt(run: RunRecord, receiptHash: string): "hedera" | "arc" {
  return run.requests.find((r) => r.receiptHash === receiptHash)?.rail ?? "hedera";
}


/** How many clean vaults to show before folding the rest away. */
const CLEAN_PREVIEW = 6;

/**
 * The verdicts, worst first, with the unremarkable ones folded behind a summary.
 *
 * A hundred-vault scan is a hundred cards — nineteen thousand pixels of them — and the
 * reader's question is "which of these needs me", not "list everything". Sorting by severity
 * answers it in the first row, and the fold keeps the rest one click away rather than
 * making the page a scroll. Nothing is hidden: the count is on the summary and the same
 * vaults are all there.
 */
function VerdictGrid({ verdicts }: { verdicts: VerdictRow[] }) {
  const rank: Record<VerdictRow["verdict"], number> = { alert: 0, watch: 1, unavailable: 2, ok: 3 };
  const sorted = [...verdicts].sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.score - a.score);
  const notable = sorted.filter((v) => v.verdict !== "ok");
  const clean = sorted.filter((v) => v.verdict === "ok");
  const shown = clean.slice(0, CLEAN_PREVIEW);
  const folded = clean.slice(shown.length);

  return (
    <div className="stack">
      <div className="grid">
        {[...notable, ...shown].map((v) => (
          <VerdictCard key={v.vaultId} v={v} />
        ))}
      </div>
      {folded.length > 0 && (
        <details>
          <summary className="faint">
            {folded.length} more vault{folded.length === 1 ? "" : "s"} with nothing flagged
          </summary>
          <div className="grid">
            {folded.map((v) => (
              <VerdictCard key={v.vaultId} v={v} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}


/**
 * The decisions, actions first and the holds folded — the same triage as the verdicts, for
 * the same reason: a hundred-vault run produces ninety-eight "hold" cards whose only
 * information is that nothing is wrong.
 */
function DecisionGrid({ decisions, run }: { decisions: RunRecord["decisions"]; run: RunRecord }) {
  const holds = decisions.filter((d) => d.action === "hold");
  const notable = decisions.filter((d) => d.action !== "hold");
  const shown = holds.slice(0, CLEAN_PREVIEW);
  const folded = holds.slice(shown.length);

  const card = (d: RunRecord["decisions"][number], i: number) => (
    <div className={`card verdict ${actionTone(d.action)}`} key={`${d.vaultId}-${i}`}>
      <div className="row between">
        <Id value={d.vaultId} head={10} tail={4} />
        <span className={`badge ${actionTone(d.action)}`}>{d.action}</span>
      </div>
      <p>{d.reason}</p>
      <p className="faint">
        {d.citations.source} · block {d.citations.block}
        {d.citations.txId && (
          <>
            {" · "}
            <a href={explorerTxUrl(railForReceipt(run, d.citations.receiptHash), d.citations.txId)}>transaction</a>
          </>
        )}
      </p>
      <p className="faint">
        receipt <Id value={d.citations.receiptHash} />
      </p>
    </div>
  );

  return (
    <div className="stack">
      <div className="grid">
        {notable.map(card)}
        {shown.map((d, i) => card(d, notable.length + i))}
      </div>
      {folded.length > 0 && (
        <details>
          <summary className="faint">
            {folded.length} more vault{folded.length === 1 ? "" : "s"} to hold
          </summary>
          <div className="grid">{folded.map((d, i) => card(d, notable.length + shown.length + i))}</div>
        </details>
      )}
    </div>
  );
}

function RequestSection({ req, lookup }: { req: RequestRecord; lookup: ReceiptLookup | null }) {
  return (
    <section className="stack">
      <div className="row between">
        <h3>
          {req.rail} / {req.tier}
          {req.sealed && <span className="pill">sealed</span>}
        </h3>
        <span className="badge neutral">{req.priceUsd ?? "n/a"} USD</span>
      </div>

      <div className="card">
        <dl className="kv">
          <dt>Payment</dt>
          <dd>{req.txId ? <Id value={req.txId} href={explorerTxUrl(req.rail, req.txId)} head={16} tail={6} /> : "n/a"}</dd>
          <dt>Receipt</dt>
          <dd>
            <Id value={req.receiptHash} />
          </dd>
          <dt>HCS commitment</dt>
          <dd>
            {lookup ? (
              lookup.sequence ? (
                <span className="ok">
                  sequence {lookup.sequence} · topic {lookup.topicId ?? "n/a"}
                  {lookup.consensus_timestamp && <> · {new Date(Number(lookup.consensus_timestamp.split(".")[0]) * 1000).toISOString()}</>}
                </span>
              ) : (
                <span className="warn">pending — the commitment is asynchronous</span>
              )
            ) : (
              <span className="error">could not fetch /v1/receipts/{req.receiptHash.slice(0, 12)}…</span>
            )}
          </dd>
        </dl>
      </div>

      {req.verdicts.length === 0 ? (
        <p className="empty">
          No verdicts. This is a whole-protocol table pull {req.rejected.length > 0 && "whose every vault was refused as stale"}.
        </p>
      ) : (
        <VerdictGrid verdicts={req.verdicts} />
      )}

      {req.rejected.length > 0 && (
        <p className="faint">
          Refused as stale by this run&rsquo;s own age check:
          {req.rejected.map((r) => (
            <span className="pill" key={r.vaultId}>
              <Id value={r.vaultId} head={10} tail={4} /> · {r.ageSeconds}s old
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

/**
 * One vault: the verdict, the score, the shape the flags are about, and the flags.
 *
 * The chart is the point. A flag reads "share price −12.4% (threshold −5%, window 24h)", and
 * without the series behind it the reader has to take that on trust; with it they can see
 * which part of the series the claim covers, because the window is shaded. Runs that predate
 * the series being recorded — and the committed demo fixture — fall back to the flags alone
 * rather than drawing an empty box.
 */
function VerdictCard({ v }: { v: VerdictRow }) {
  const tones = v.flags.map((f) => WINDOW_SECONDS[f.window] ?? 0);
  const widest = tones.length ? Math.max(...tones) : 0;
  const latest = v.history?.length ? v.history[v.history.length - 1].t : 0;
  const window = widest > 0 ? { from: latest - widest, to: latest } : undefined;
  // Shown whenever the run recorded a series, flags or not: the series is what the buyer
  // paid for, and a flat line beside an `ok` verdict says more than the word alone.
  const showChart = v.history !== undefined && v.history.length > 1;

  return (
    <div className={`card verdict ${v.verdict}`}>
      <div className="row between">
        <Id value={v.vaultId} head={10} tail={4} />
        <VerdictBadge verdict={v.verdict} />
      </div>

      <ScoreBar score={v.score} verdict={v.verdict} />

      {showChart && (
        <Sparkline
          points={v.history!}
          window={window}
          tone={v.verdict === "unavailable" ? "absent" : v.verdict}
          label={`Share price series for ${v.vaultId}, ${v.history!.length} points${
            window ? `, the shaded part being the ${v.flags[0].window} window a flag was computed over` : ""
          }`}
        />
      )}

      {v.flags.length === 0 ? (
        <p className="faint">Within every threshold this run checks.</p>
      ) : (
        <ul className="stack tight" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {v.flags.map((f) => (
            <li key={f.name} className="row" style={{ gap: "0.5rem" }}>
              <span className={`badge ${v.verdict === "alert" ? "alert" : "watch"}`}>{f.window}</span>
              <span>
                <strong>{flagLabel(f.name)}</strong> {flagPercent(f.value).toFixed(1)}%{" "}
                <span className="faint">(threshold {flagPercent(f.threshold).toFixed(1)}%)</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
