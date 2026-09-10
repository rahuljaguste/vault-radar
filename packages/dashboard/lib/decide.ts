/**
 * A deliberately minimal local stand-in for the agent's decision logic, used by
 * `POST /api/scan` only.
 *
 * TODO: delete this file and import `applyAgeCheck` and `decide` from
 * `packages/agent/src/policy.ts` (exported via `@vaultradar/agent`) once that
 * module lands on `main`. Those are the reviewed implementations; these two
 * functions exist only so the paid-scan route is not blocked on them, and they
 * mirror their signatures so the swap is an import change plus passing the
 * loaded `Policy` instead of a bare `maxAgeSeconds`. Nothing else should import
 * this module.
 */

import type { PaidResult } from "@vaultradar/agent";
import type { Attestation } from "@vaultradar/core";
import type { RunRecord } from "./types";

type Decision = RunRecord["decisions"][number];
type Rejected = RunRecord["requests"][number]["rejected"][number];

export type AgeCheck = { accepted: Attestation[]; rejected: Rejected[] };

/**
 * Splits a purchase's attestations into fresh and too-old, measured against the
 * signed timestamps rather than the service's own `freshness` label, so a
 * service that widens its staleness window cannot talk the dashboard into
 * showing old numbers as current.
 *
 * An unparseable timestamp is treated as dating from the epoch (age = `now`),
 * which is finite (the run-file contract wants a plain number) and past any sane
 * bar.
 */
export function applyAgeCheck(result: PaidResult, maxAgeSeconds: number, now: number): AgeCheck {
  const accepted: Attestation[] = [];
  const rejected: Rejected[] = [];
  for (const a of result.attestations) {
    const ts = Number(a.timestamp);
    const ageSeconds = Number.isFinite(ts) ? now - ts : now;
    if (ageSeconds > maxAgeSeconds) rejected.push({ vaultId: a.vaultId, ageSeconds });
    else accepted.push(a);
  }
  return { accepted, rejected };
}

/** The verdict-to-action mapping. The whole point of this module. */
const ACTION_FOR = {
  alert: "withdraw",
  watch: "rebalance",
  ok: "hold",
} as const;

/**
 * One action per vault, each carrying the evidence a reader needs to check it.
 *
 * Three things force `"insufficient data"` instead of an action: the service
 * reporting `unavailable`, the age check rejecting the vault, and the vault
 * having no accepted attestation at all. The last covers a report the service
 * never attested to, since unattested numbers are not evidence.
 */
export function decide(result: PaidResult, age: AgeCheck, receiptHash: string): Decision[] {
  const rejected = new Map(age.rejected.map((r) => [r.vaultId, r.ageSeconds]));
  const accepted = new Map(age.accepted.map((a) => [a.vaultId, a]));

  return result.reports.map((report) => {
    const attestation = accepted.get(report.vaultId);
    const evidence = report.evidence[0];
    const citations = {
      block: evidence?.block ?? attestation?.block ?? "",
      source: evidence?.source ?? attestation?.source ?? "",
      txId: result.txId ?? result.receipt.payment.txId ?? null,
      receiptHash,
    };
    const flags = report.flags.length ? `flags ${report.flags.map((f) => f.name).join(", ")}` : "no flags";

    const staleBy = rejected.get(report.vaultId);
    if (staleBy !== undefined) {
      return {
        vaultId: report.vaultId,
        action: "insufficient data" as const,
        reason: `Attestation is ${staleBy}s old and was rejected by the max-age check, so the ${report.verdict} verdict (${flags}) cannot be acted on.`,
        citations,
      };
    }
    if (!attestation) {
      return {
        vaultId: report.vaultId,
        action: "insufficient data" as const,
        reason: `The service returned no attestation for this vault, so its ${report.verdict} verdict (${flags}) is unattested.`,
        citations,
      };
    }
    if (report.verdict === "unavailable") {
      return {
        vaultId: report.vaultId,
        action: "insufficient data" as const,
        reason: `The service reported verdict unavailable (${flags}), so there is nothing to act on.`,
        citations,
      };
    }
    const action = ACTION_FOR[report.verdict];
    return {
      vaultId: report.vaultId,
      action,
      reason: `Verdict ${report.verdict} at score ${report.score} with ${flags}: ${action}.`,
      citations,
    };
  });
}
