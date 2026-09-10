import type { Receipt } from "@vaultradar/core";

/**
 * Shape of a run file written by the agent to `<repo>/runs/<id>.json`.
 * This is a cross-package contract with the agent (a separate task) — keep it
 * in exact sync with what the agent emits. Do not add fields here speculatively.
 */
export type RunRecord = {
  id: string;
  startedAt: string;
  serviceUrl: string;
  policy: {
    budget: { usdc_hedera: string; usdc_arc: string };
    privacy: "strict" | "balanced" | "cheap";
    rail_preference: "cheapest" | "hedera" | "arc";
    max_age_seconds: number;
  };
  discovery: {
    cardSignatureValid: boolean;
    pubHash: string;
    kid: string;
    onChain: { chainId: string; agentId: string; matches: boolean | null }[];
  };
  requests: {
    rail: "hedera" | "arc";
    tier: "scan" | "table";
    sealed: boolean;
    priceUsd: string | null;
    txId: string | null;
    receiptHash: string;
    receipt: Receipt;
    verdicts: {
      vaultId: string;
      verdict: "ok" | "watch" | "alert" | "unavailable";
      score: number;
      flags: { name: string; value: string; threshold: string; window: string }[];
    }[];
    rejected: { vaultId: string; ageSeconds: number }[];
  }[];
  decisions: {
    vaultId: string;
    action: "hold" | "withdraw" | "rebalance" | "insufficient data";
    reason: string;
    citations: { block: string; source: string; txId: string | null; receiptHash: string };
  }[];
};
