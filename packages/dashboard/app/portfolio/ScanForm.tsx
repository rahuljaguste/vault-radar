"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table } from "@/app/components/Table";
import { explorerTxUrl, type Rail } from "@/lib/explorer";
import { EXAMPLE_VAULT_ID, MAX_VAULTS, parseVaultList } from "@/lib/vaults";
import type { RunMatch, RunRecord } from "@/lib/types";

/** The `POST /api/scan` success body. */
type ScanResponse = {
  runId: string;
  requests: RunRecord["requests"];
  decisions: RunRecord["decisions"];
  txId: string | null;
  receiptHash: string;
  priceUsd: string | null;
};

type Busy = "idle" | "scanning" | "history";

export function ScanForm({ keysConfigured, demoRunId }: { keysConfigured: boolean; demoRunId: string | null }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [history, setHistory] = useState<RunMatch[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // The same parser the API route runs. Here it only drives the live count and the
  // inline hint; the route re-parses every request and is the authority.
  const parsed = parseVaultList(text);
  const empty = text.trim() === "";
  const running = busy !== "idle";

  const loadHistory = useCallback(async (vaults: string[]) => {
    setHistoryError(null);
    try {
      const res = await fetch(`/api/runs?vaults=${encodeURIComponent(vaults.join(","))}`, { cache: "no-store" });
      const body = await readJson(res);
      if (!res.ok) {
        setHistoryError(errorText(body) ?? `Could not load history (HTTP ${res.status}).`);
        return;
      }
      setHistory(((body as { matches?: RunMatch[] } | null)?.matches ?? []) as RunMatch[]);
    } catch (e) {
      setHistoryError(`Could not load history: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  async function onShowHistory() {
    if (!parsed.ok) return;
    setBusy("history");
    try {
      await loadHistory(parsed.vaults);
    } finally {
      setBusy("idle");
    }
  }

  async function onScan() {
    if (!parsed.ok) return;
    setBusy("scanning");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vaults: parsed.vaults }),
      });
      const body = await readJson(res);
      if (!res.ok) {
        setError(scanErrorMessage(res.status, body));
        return;
      }
      setResult(body as ScanResponse);
      // A purchase is itself new history, so refresh it rather than leaving the
      // previous answer on screen looking current.
      await loadHistory(parsed.vaults);
    } catch (e) {
      setError(`The scan request failed before it reached the server: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("idle");
    }
  }

  return (
    <>
      <section className="stack">
        <div className="stack tight">
          <Label htmlFor="vaults">
            One vault per line, as <code>&lt;chainId&gt;:0x&lt;40 hex address&gt;</code>. Up to {MAX_VAULTS} per scan.
          </Label>
          <Textarea
            id="vaults"
            rows={6}
            spellCheck={false}
            // One real example, which the service resolves. The second line used to be
            // `8453:0x000…000` — an address that exists nowhere, on a chain the service
            // currently returns no vaults for at all, so following the example failed twice.
            placeholder={EXAMPLE_VAULT_ID}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={running}
            className="font-mono text-xs"
          />
          <p aria-live="polite" className={`text-sm ${!empty && !parsed.ok ? "error" : "muted"}`}>
            {empty
              ? "Paste a vault list to begin."
              : parsed.ok
                ? `${parsed.vaults.length} vault${parsed.vaults.length === 1 ? "" : "s"} ready.`
                : parsed.error}
          </p>
        </div>

        {/* What the buttons do comes before the buttons. It used to sit underneath them, so a
            visitor met "Scan now" with no statement of what it costs or who pays until after
            they had read past it, and when the keys are missing, the reason both buttons are
            disabled arrived last instead of first. */}
        {keysConfigured ? (
          <p className="muted text-sm">
            &ldquo;Scan now&rdquo; buys a real x402 request. The payer is the operator&apos;s agent account, not your
            wallet. One purchase is capped by the agent&apos;s policy budget and a per-scan ceiling; across everyone, a
            rolling daily spend cap and an hourly scan allowance apply as well (see above). One scan per 30 seconds per
            client on top of that.
          </p>
        ) : (
          <Alert>
            <AlertTitle>Paid scans are unavailable</AlertTitle>
            <AlertDescription>
              This dashboard has no agent payment keys. Set <code>AGENT_HEDERA_ACCOUNT_ID</code> and{" "}
              <code>AGENT_HEDERA_KEY</code> in the dashboard&apos;s environment to enable purchases. The keys are read
              server-side only and never reach the browser.
              {demoRunId && (
                <>
                  {" "}
                  In the meantime, <Link href={`/runs/${encodeURIComponent(demoRunId)}`}>open a finished run</Link> to
                  see the same verdicts, decisions and receipts a purchase produces.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="toolbar">
          <Button type="button" onClick={onScan} disabled={running || !parsed.ok || !keysConfigured}>
            {busy === "scanning" ? "Paying and scanning..." : "Scan now"}
          </Button>
          <Button type="button" variant="outline" onClick={onShowHistory} disabled={running || !parsed.ok}>
            {busy === "history" ? "Loading..." : "Show history (free)"}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>The scan failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>

      {result && <Result result={result} />}
      {(history !== null || historyError) && <History matches={history ?? []} error={historyError} />}
    </>
  );
}

/* ----------------------------------------------------------------- results */

function Result({ result }: { result: ScanResponse }) {
  const rail = result.requests[0]?.rail ?? null;
  const txUrl = rail && result.txId ? explorerTxUrl(rail as Rail, result.txId) : null;

  return (
    <>
      <section>
        <h2>This purchase</h2>
        <dl>
          <dt>Run</dt>
          <dd>
            <Link href={`/runs/${encodeURIComponent(result.runId)}`}>{result.runId}</Link>
          </dd>
          <dt>Price</dt>
          <dd className="num">{result.priceUsd ? `${result.priceUsd} USD` : "-"}</dd>
          <dt>Payment</dt>
          <dd>
            {result.txId ? (
              txUrl ? (
                <a href={txUrl} target="_blank" rel="noopener noreferrer">
                  <code>{result.txId}</code>
                </a>
              ) : (
                <code>{result.txId}</code>
              )
            ) : (
              <span className="muted">no transaction id returned</span>
            )}
          </dd>
          <dt>Receipt hash</dt>
          <dd>
            <code>{result.receiptHash}</code> <Link href="/verify">verify it</Link>
          </dd>
        </dl>
      </section>

      {result.requests.map((req, i) => (
        <section key={`${req.receiptHash}-${i}`}>
          <h2>
            Verdicts <span className="muted text-sm">({req.rail} rail, {req.tier} tier, {req.sealed ? "sealed" : "clear"})</span>
          </h2>
          {req.verdicts.length === 0 ? (
            <p className="empty">The service returned no verdicts for this request.</p>
          ) : (
            <Table
              columns={[
                {
                  key: "vaultId",
                  label: "Vault",
                  render: (v: RunRecord["requests"][number]["verdicts"][number]) => <code>{v.vaultId}</code>,
                },
                {
                  key: "verdict",
                  label: "Verdict",
                  render: (v: RunRecord["requests"][number]["verdicts"][number]) => (
                    <span className={verdictTone(v.verdict)}>{v.verdict}</span>
                  ),
                },
                {
                  key: "score",
                  label: "Score",
                  render: (v: RunRecord["requests"][number]["verdicts"][number]) => (
                    <span className="num">{String(v.score)}</span>
                  ),
                },
                {
                  key: "flags",
                  label: "Flags",
                  render: (v: RunRecord["requests"][number]["verdicts"][number]) =>
                    v.flags.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      v.flags.map((f) => (
                        <span className="pill" key={f.name}>
                          {f.name} {f.value} vs {f.threshold} over {f.window}
                        </span>
                      ))
                    ),
                },
              ]}
              rows={req.verdicts}
              rowKey={(v) => v.vaultId}
            />
          )}
          {req.rejected.length > 0 && (
            <p className="warn text-sm">
              Rejected as too old by the agent&apos;s own max-age check:{" "}
              {req.rejected.map((r) => `${r.vaultId} (${r.ageSeconds}s)`).join(", ")}
            </p>
          )}
        </section>
      ))}

      <section>
        <h2>Decisions</h2>
        {result.decisions.length === 0 ? (
          <p className="empty">No decisions were reached.</p>
        ) : (
          <Table
            columns={[
              {
                key: "vaultId",
                label: "Vault",
                render: (d: RunRecord["decisions"][number]) => <code>{d.vaultId}</code>,
              },
              {
                key: "action",
                label: "Action",
                render: (d: RunRecord["decisions"][number]) => <span className={actionTone(d.action)}>{d.action}</span>,
              },
              { key: "reason", label: "Reason", render: (d: RunRecord["decisions"][number]) => d.reason },
              {
                key: "evidence",
                label: "Evidence",
                render: (d: RunRecord["decisions"][number]) => {
                  const citedUrl = rail && d.citations.txId ? explorerTxUrl(rail as Rail, d.citations.txId) : null;
                  return (
                    <span className="text-sm">
                      block <code>{d.citations.block || "-"}</code>
                      <br />
                      source <code>{d.citations.source || "-"}</code>
                      <br />
                      receipt <code>{d.citations.receiptHash}</code>
                      {d.citations.txId && (
                        <>
                          <br />
                          tx{" "}
                          {citedUrl ? (
                            <a href={citedUrl} target="_blank" rel="noopener noreferrer">
                              <code>{d.citations.txId}</code>
                            </a>
                          ) : (
                            <code>{d.citations.txId}</code>
                          )}
                        </>
                      )}
                    </span>
                  );
                },
              },
            ]}
            rows={result.decisions}
            rowKey={(d) => d.vaultId}
          />
        )}
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- history */

function History({ matches, error }: { matches: RunMatch[]; error: string | null }) {
  return (
    <section>
      <h2>History for these vaults</h2>
      {error && <p className="error">{error}</p>}
      {!error && matches.length === 0 && <p className="empty">No earlier run covered any of these vaults.</p>}
      {matches.length > 0 && (
        <Table
          columns={[
            {
              key: "id",
              label: "Run",
              render: (m: RunMatch) => <Link href={`/runs/${encodeURIComponent(m.id)}`}>{m.id}</Link>,
            },
            { key: "startedAt", label: "Started at", render: (m: RunMatch) => <span className="num">{m.startedAt}</span> },
            {
              key: "matched",
              label: "Matched vaults",
              render: (m: RunMatch) => m.matched.map((v) => <code key={v}>{v}</code>),
            },
            {
              key: "verdicts",
              label: "Verdicts",
              render: (m: RunMatch) =>
                m.verdicts.length === 0 ? (
                  <span className="muted">-</span>
                ) : (
                  m.verdicts.map((v) => (
                    <span className="pill" key={`${v.vaultId}-${v.verdict}`}>
                      <span className={verdictTone(v.verdict)}>{v.verdict}</span> {String(v.score)}
                    </span>
                  ))
                ),
            },
            {
              key: "actions",
              label: "Actions",
              render: (m: RunMatch) =>
                m.actions.length === 0 ? (
                  <span className="muted">-</span>
                ) : (
                  m.actions.map((a) => (
                    <span className="pill" key={`${a.vaultId}-${a.action}`}>
                      <span className={actionTone(a.action)}>{a.action}</span>
                    </span>
                  ))
                ),
            },
          ]}
          rows={matches}
          rowKey={(m) => m.id}
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- helpers */

function verdictTone(verdict: string): string {
  if (verdict === "ok") return "ok";
  if (verdict === "watch") return "warn";
  if (verdict === "alert") return "error";
  return "muted";
}

function actionTone(action: string): string {
  if (action === "hold") return "ok";
  if (action === "rebalance") return "warn";
  if (action === "withdraw") return "error";
  return "muted";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    // A 404 before the route exists, or a proxy error page, is HTML, not JSON.
    return null;
  }
}

function errorText(body: unknown): string | null {
  return field(body, "error");
}

/** Reads one optional string field off an untrusted JSON body. */
function field(body: unknown, name: string): string | null {
  if (typeof body === "object" && body !== null && name in body) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  return null;
}

/** The same, for a field the route sends as a JSON number rather than a string. */
function numberField(body: unknown, name: string): number | null {
  if (typeof body === "object" && body !== null && name in body) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The route answers the two spending refusals with a short machine-readable code
 * plus the amounts. Turn them into a sentence here, so the browser never shows a
 * bare `over_budget` to a reader.
 */
function spendingRefusal(body: unknown, code: string): string | null {
  const quote = field(body, "quoteUsd");
  if (code === "over_budget") {
    const budget = field(body, "budgetUsd");
    return quote && budget
      ? `Over budget: this scan costs ${quote} USD and the agent policy allows ${budget} USD per purchase on the Hedera rail. Scan fewer vaults or raise the policy budget.`
      : "Over budget: this scan costs more than the agent policy allows per purchase on the Hedera rail.";
  }
  if (code === "over_per_scan_ceiling") {
    const ceiling = field(body, "ceilingUsd");
    return quote && ceiling
      ? `Over the per-scan ceiling: this scan costs ${quote} USD and the dashboard refuses to spend more than ${ceiling} USD in one purchase.`
      : "Over the per-scan ceiling: this scan costs more than the dashboard will spend in one purchase.";
  }
  return null;
}

/**
 * The aggregate refusals, which are about the deployment's allowance rather than about
 * this request. Rendered as sentences here so the browser never shows a bare
 * `spend_cap_24h` to a reader.
 */
function allowanceRefusal(body: unknown, code: string): string | null {
  if (code === "spend_cap_24h") {
    const spent = field(body, "spentUsd");
    const cap = field(body, "capUsd");
    return spent && cap
      ? `This dashboard has spent ${spent} of its ${cap} USD daily allowance, and this scan would take it over. Try again once the rolling 24-hour window clears.`
      : "This dashboard has reached its daily spending allowance. Try again once the rolling 24-hour window clears.";
  }
  if (code === "scan_rate_1h") {
    const max = numberField(body, "maxScansPerHour");
    return max !== null
      ? `This dashboard allows ${max} paid scans an hour across all visitors, and that is used up. Try again shortly.`
      : "This dashboard's hourly scan allowance is used up. Try again shortly.";
  }
  return null;
}

/** Maps the route's documented status codes to something a portfolio owner can act on. */
function scanErrorMessage(status: number, body: unknown): string {
  const detail = errorText(body);
  if (status === 401) {
    return "This dashboard requires an access token for paid scans, and the request did not carry a valid one.";
  }
  if (status === 503) {
    return detail
      ? `Paid scans are unavailable: ${detail}.`
      : "Paid scans are unavailable: the dashboard has no agent payment keys configured.";
  }
  if (status === 429) {
    if (detail) return allowanceRefusal(body, detail) ?? detail;
    return "Rate limited: one paid scan per 30 seconds. Wait a moment and try again.";
  }
  if (status === 400) {
    if (detail) return spendingRefusal(body, detail) ?? detail;
    return "The vault list was rejected.";
  }
  if (status === 404) {
    return "This dashboard build has no /api/scan route, so nothing can be purchased from the browser.";
  }
  return detail ? `The scan failed: ${detail}` : `The scan failed (HTTP ${status}).`;
}
