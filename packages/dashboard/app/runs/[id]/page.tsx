import { notFound } from "next/navigation";
import { getRun } from "@/lib/runs";
import { fetchReceiptLookup, type ReceiptLookup } from "@/lib/service";
import { explorerTxUrl } from "@/lib/explorer";
import { Table } from "@/app/components/Table";
import type { RunRecord } from "@/lib/types";

type RequestRecord = RunRecord["requests"][number];

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const lookups = await Promise.all(run.requests.map((r) => fetchReceiptLookup(r.receiptHash)));

  return (
    <>
      <h2>Run {run.id}</h2>
      <dl>
        <dt>Started at</dt>
        <dd>{run.startedAt}</dd>
        <dt>Service URL</dt>
        <dd>{run.serviceUrl}</dd>
        <dt>Policy</dt>
        <dd>
          budget hedera {run.policy.budget.usdc_hedera} USDC, arc {run.policy.budget.usdc_arc} USDC — privacy {run.policy.privacy} — rail preference{" "}
          {run.policy.rail_preference} — max age {run.policy.max_age_seconds}s
        </dd>
        <dt>Discovery</dt>
        <dd>
          card signature {run.discovery.cardSignatureValid ? "valid" : "INVALID"} — pub_hash <code>{run.discovery.pubHash}</code> — kid{" "}
          <code>{run.discovery.kid}</code>
          <br />
          on-chain: {run.discovery.onChain.length === 0 && "none checked"}
          {run.discovery.onChain.map((o) => (
            <span key={o.chainId} className="pill">
              {o.chainId}:{o.agentId} ({o.matches === null ? "not checked" : o.matches ? "matches" : "MISMATCH"})
            </span>
          ))}
        </dd>
      </dl>

      <h3>Requests</h3>
      {run.requests.map((req, i) => (
        <RequestCard key={req.receiptHash} req={req} lookup={lookups[i] ?? null} />
      ))}

      <h3>Decisions</h3>
      <Table
        columns={[
          { key: "vaultId", label: "Vault" },
          { key: "action", label: "Action" },
          { key: "reason", label: "Reason" },
          {
            key: "citations",
            label: "Citation",
            render: (row) => (
              <>
                {row.citations.source} / block {row.citations.block}
                {row.citations.txId && (
                  <>
                    {" "}
                    (<a href={explorerTxUrl(railForReceipt(run, row.citations.receiptHash), row.citations.txId)}>tx</a>)
                  </>
                )}
                <br />
                receipt <code>{row.citations.receiptHash}</code>
              </>
            ),
          },
        ]}
        rows={run.decisions}
        rowKey={(row, i) => `${row.vaultId}-${i}`}
        empty="No decisions recorded."
      />
    </>
  );
}

/** Look up which rail a cited receipt was paid on, to pick the right explorer link. Defaults to hedera if not found. */
function railForReceipt(run: RunRecord, receiptHash: string): "hedera" | "arc" {
  return run.requests.find((r) => r.receiptHash === receiptHash)?.rail ?? "hedera";
}

function RequestCard({ req, lookup }: { req: RequestRecord; lookup: ReceiptLookup | null }) {
  return (
    <div className="card">
      <dl>
        <dt>Rail / tier</dt>
        <dd>
          {req.rail} / {req.tier} {req.sealed && <span className="pill">sealed</span>}
        </dd>
        <dt>Price</dt>
        <dd>{req.priceUsd ?? "n/a"}</dd>
        <dt>Payment tx</dt>
        <dd>{req.txId ? <a href={explorerTxUrl(req.rail, req.txId)}>{req.txId}</a> : "n/a"}</dd>
        <dt>Receipt hash</dt>
        <dd>
          <code>{req.receiptHash}</code>
        </dd>
        <dt>HCS sequence</dt>
        <dd>
          {lookup ? (
            <>
              topic {lookup.topicId ?? "n/a"} — sequence {lookup.sequence ?? "pending"}
              {lookup.consensus_timestamp && <> — consensus time {lookup.consensus_timestamp}</>}
            </>
          ) : (
            <span className="error">could not fetch /v1/receipts/{req.receiptHash}</span>
          )}
        </dd>
      </dl>

      <Table
        columns={[
          { key: "vaultId", label: "Vault" },
          { key: "verdict", label: "Verdict" },
          { key: "score", label: "Score" },
          {
            key: "flags",
            label: "Flags",
            render: (row) =>
              row.flags.length === 0
                ? "none"
                : row.flags.map((f) => (
                    <span key={f.name} className="pill">
                      {f.name}: {f.value} (threshold {f.threshold}, window {f.window})
                    </span>
                  )),
          },
        ]}
        rows={req.verdicts}
        rowKey={(row) => row.vaultId}
        empty="No verdicts."
      />

      {req.rejected.length > 0 && (
        <p>
          Rejected (stale): {req.rejected.map((r) => `${r.vaultId} (${r.ageSeconds}s old)`).join(", ")}
        </p>
      )}
    </div>
  );
}
