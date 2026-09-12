### Task 27: Service metrics endpoint and settlement tracking

**Files:**
- Create: `packages/service/src/metrics.ts`, `packages/service/src/admin.ts`, `packages/service/test/metrics.test.ts`, `packages/service/test/admin.test.ts`
- Modify: `packages/service/src/handlers/scan.ts` (count requests, verdicts, 4xx), `packages/service/src/rails/hedera.ts` and `src/rails/arc.ts` (record settlements through the existing `onSettled` hooks), `packages/service/src/hcs.ts` (expose counters), `packages/service/src/data/provider.ts` (record per-deployment outcomes and heads), `packages/service/src/app.ts` (mount admin router; construct `Metrics`), `packages/service/src/config.ts` (`ADMIN_TOKEN`), `.env.example`

**Interfaces:**
- Produces: `class Metrics { requests: { scan; table; rejected4xx; unavailableVerdicts; lastRequestAt }; settlements: { hedera: { count; revenueAtomic }; arc: { count; revenueUsd } }; recordRequest(tier, status, verdicts?); recordSettlement(rail, amount); recordDeployment(ref, outcome); recordHead(chainId, head, ok); snapshot(deps): Promise<AdminMetrics> }`; `mountAdmin(app, { config, metrics, hcs, keys, data, readPqHash })` registering `GET /v1/admin/metrics` with the bearer check; the JSON shape from spec §13.1 exactly.

- [ ] **Step 1: Failing tests** — `metrics.test.ts`: counters increment; `snapshot()` produces every field with string numerics and `uptimeSeconds` monotonic; `admin.test.ts`: `GET /v1/admin/metrics` without token → 401 `{ reason: "unauthorized" }`; with token → 200 and a body matching the shape (zod schema in the test); rail health probe uses an injected fetch and reports `healthy: false` on a failed probe without throwing.
- [ ] **Step 2: Implement** — `Metrics` as a plain class with a `startedAt`; handlers call `metrics.recordRequest`; rails call `metrics.recordSettlement` from their settlement hooks (Hedera: `onAfterSettle` with the requirement's atomic amount; Arc: `req.payment.amount`); `HcsQueue` gains `stats()` `{ pending, submitted, failed, lastSequence }`; `LiveDataProvider` records each deployment's last outcome and each chain head; `mountAdmin` assembles the snapshot with 30 s cached health probes and a 10 min cached identity check via `readPqHash`.
- [ ] **Step 3: Run tests and typecheck; commit** — `git commit -m "feat(service): admin metrics endpoint with settlement, HCS, freshness and identity status"`

