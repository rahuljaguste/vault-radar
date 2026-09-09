import type { Freshness, Source, SourceKind } from "./types";

export const THRESHOLDS: Record<SourceKind, number> = { messari: 3600, substreams: 300 };

export function classifyFreshness(kind: SourceKind, sourceTs: number, headTs: number, error = false): Freshness {
  if (error) return "unavailable";
  return headTs - sourceTs <= THRESHOLDS[kind] ? "fresh" : "stale";
}

const RANK: Record<Freshness, number> = { fresh: 0, stale: 1, unavailable: 2 };

export function vaultFreshness(sources: Source[]): Freshness {
  if (!sources.length) return "unavailable";
  return sources.reduce<Freshness>((w, s) => (RANK[s.freshness] > RANK[w] ? s.freshness : w), "fresh");
}
