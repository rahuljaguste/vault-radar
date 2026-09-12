import type { Freshness, Source, SourceKind } from "./types";

/**
 * How old a source's own timestamp may be before its data is called stale.
 *
 * The Substreams figure is set above Ethereum's *finality* lag, not above its block time.
 * The sink runs with `--final-blocks-only`, so the newest block it will ever write is the
 * last finalized one — around 64 to 95 blocks, or 13 to 19 minutes, behind the head. A
 * five-minute threshold (spec §7's original figure) was therefore unsatisfiable: the sink
 * was correct and current and every vault it backed still read `stale`, which is worse than
 * useless because it reports "no data" for data that is final and right. Twenty minutes
 * Measured against the running sink, the lag is not a constant: finality puts a floor of
 * roughly 64 to 95 blocks on it, and the pipeline's own jitter pushes the cursor to around
 * 80 to 150 blocks — 16 to 30 minutes — as it catches up and drifts back. A threshold
 * inside that band makes freshness a coin toss, which is what a 20-minute figure turned out
 * to be: one scan of 100 vaults came back entirely `stale`, minutes later the same query
 * would have been fresh. Thirty minutes sits just above the observed band, while staying
 * well under the Messari threshold because on-chain data still has a block to point at.
 */
export const THRESHOLDS: Record<SourceKind, number> = { messari: 3600, substreams: 1800 };

export function classifyFreshness(kind: SourceKind, sourceTs: number, headTs: number, error = false): Freshness {
  if (error) return "unavailable";
  return headTs - sourceTs <= THRESHOLDS[kind] ? "fresh" : "stale";
}

const RANK: Record<Freshness, number> = { fresh: 0, stale: 1, unavailable: 2 };

export function vaultFreshness(sources: Source[]): Freshness {
  if (!sources.length) return "unavailable";
  return sources.reduce<Freshness>((w, s) => (RANK[s.freshness] > RANK[w] ? s.freshness : w), "fresh");
}
