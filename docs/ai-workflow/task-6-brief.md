### Task 6: Unified vault types and freshness

**Files:**
- Create: `packages/core/src/unify/types.ts`, `packages/core/src/unify/freshness.ts`, `packages/core/test/freshness.test.ts`

**Interfaces:**
- Produces: `type Freshness = "fresh" | "stale" | "unavailable"`; `type SourceKind = "messari" | "substreams"`; `type Source = { kind: SourceKind; ref: string; block: string; timestamp: string; ageSeconds: string; freshness: Freshness }`; `type HistoryPoint = { block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; netFlowAssets: string | null }`; `type UnifiedVault = { id: string; kind: "yield-vault" | "lending-market" | "erc4626"; protocol: string; chain: string; chainId: string; asset: { symbol: string; decimals: number } | null; sharePrice: string; tvlUsd: string | null; inputTokenBalance: string | null; depositLimit: string | null; history: HistoryPoint[]; sources: Source[]; freshness: Freshness }`; `classifyFreshness(kind: SourceKind, sourceTimestamp: number, headTimestamp: number, error?: boolean): Freshness`; `vaultFreshness(sources: Source[]): Freshness` (worst of sources; empty → unavailable); `THRESHOLDS = { messari: 3600, substreams: 300 }`.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { classifyFreshness, vaultFreshness } from "../src/unify/freshness";

test("messari within 3600s is fresh, beyond is stale, error is unavailable", () => {
  expect(classifyFreshness("messari", 1000, 4600)).toBe("fresh");
  expect(classifyFreshness("messari", 1000, 4601)).toBe("stale");
  expect(classifyFreshness("messari", 1000, 1001, true)).toBe("unavailable");
});
test("substreams threshold is 300s", () => {
  expect(classifyFreshness("substreams", 1000, 1300)).toBe("fresh");
  expect(classifyFreshness("substreams", 1000, 1301)).toBe("stale");
});
test("vault freshness is the worst source; no sources is unavailable", () => {
  const s = (f: "fresh" | "stale" | "unavailable") => ({ kind: "messari" as const, ref: "x", block: "1", timestamp: "1", ageSeconds: "0", freshness: f });
  expect(vaultFreshness([s("fresh"), s("stale")])).toBe("stale");
  expect(vaultFreshness([s("fresh"), s("unavailable")])).toBe("unavailable");
  expect(vaultFreshness([])).toBe("unavailable");
});
```

- [ ] **Step 2: Run, expect failure. Step 3: Implement**

`types.ts` holds exactly the types listed in Interfaces (no logic). `freshness.ts`:

```ts
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
```

- [ ] **Step 4: Run, expect pass. Commit**, `git add -A && git commit -m "feat(core): unified vault types and freshness classification"`

