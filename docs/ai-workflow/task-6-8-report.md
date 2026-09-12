# Tasks 6–8 report: unify, risk, pricing

Branch: `ws/core`, worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/core`.
One commit per task, TDD (RED → GREEN → commit) throughout.

## Task 6: Unified vault types and freshness

**Implemented:**
- `packages/core/src/unify/types.ts` — `Freshness`, `SourceKind`, `Source`, `HistoryPoint`, `UnifiedVault` (types only, no logic), including `chainId`, `inputTokenBalance`, `depositLimit` on `UnifiedVault` as required for Task 7's tests.
- `packages/core/src/unify/freshness.ts` — `THRESHOLDS`, `classifyFreshness`, `vaultFreshness`, copied from the brief verbatim.
- `packages/core/test/freshness.test.ts` — the brief's three tests verbatim.
- `packages/core/src/index.ts` — added `export * from "./unify/types"` and `export * from "./unify/freshness"`.

**TDD evidence:**
- RED: `bun test packages/core/test/freshness.test.ts` → `error: Cannot find module '../src/unify/freshness'`, 0 pass / 1 fail.
- Implemented `types.ts` and `freshness.ts`.
- GREEN: `bun test packages/core/test/freshness.test.ts` → 3 pass, 0 fail, 8 expect() calls.

**Commit:** `2f5e867 feat(core): unified vault types and freshness classification`

## Task 7: Risk engine

**Implemented:**
- `packages/core/src/risk.ts` — `FlagName`, `Flag`, `Verdict`, `RiskReport`, `computeRisk`, following the brief's reference implementation with one deliberate deviation (see below).
- `packages/core/test/risk.test.ts` — the brief's six tests verbatim.
- `packages/core/src/index.ts` — added `export * from "./risk"`.

**Deviation from the brief's literal sample code:** the brief's sample sets `deposit_limit_reached`'s `value`/`threshold` to the raw input strings (`v.inputTokenBalance!`, `v.depositLimit!`), but the team lead's resolution states all output values are 6-decimal-formatted strings except `score` and `verdict`. I formatted these two fields with the same `fmt()` (`.toFixed(6)`) used everywhere else, so e.g. `"100"` becomes `"100.000000"`. This doesn't change any given test's outcome (no test asserts the exact string for this flag) but makes the flag's output format consistent with every other numeric flag. `stale_data`'s `value`/`threshold` are left as the raw freshness enum strings (`"stale"`/`"fresh"`) since those aren't decimal quantities — the 6-decimal rule doesn't apply to non-numeric fields, and the brief's sample and the given test (`evidence[0].ageSeconds === "9999"`, a raw pass-through) confirm evidence fields are also left as raw strings, not reformatted.

**TDD evidence:**
- RED: `bun test packages/core/test/risk.test.ts` → `error: Cannot find module '../src/risk'`, 0 pass / 1 fail.
- Implemented `risk.ts`.
- GREEN: `bun test packages/core/test/risk.test.ts` → 6 pass, 0 fail, 13 expect() calls.

**Manual trace (self-review focus area: unavailable-on-stale + window selection):**
- Traced all six cases by hand against the window bounds (1h `[3600,7200]`, 24h `[72000,108000]`, 7d `[518400,691200]`) and confirmed: healthy vault's 86400s-old point falls in the 24h window but produces a negative (price-up) drop, correctly producing no flag; the 3%/25%-outflow cases land in the 24h window only and sum to the expected 25 and 50; the 1h-specific test's 3700s-old point falls inside `[3600,7200]` and correctly fires; the stale-source test short-circuits before any numeric logic via the `v.freshness !== "fresh"` early return, independent of the (deliberately extreme) numbers supplied; the deposit-limit test has empty history so no drawdown/outflow flags interfere, isolating the score-10 assertion to the deposit-limit branch alone.
- Confirmed the "1h flag skipped without hourly data" half of that test's name (not separately asserted in the brief's test body) is still exercised implicitly: tests 1–3 all supply only 24h-range history and never trigger the 1h window, i.e., the skip path is covered by the suite even though the brief's own assertion only checks the "fires with it" half.

**Commit:** `129c535 feat(core): risk engine with unavailable-on-stale rule`

## Task 8: Pricing

**Implemented:**
- `packages/core/src/pricing.ts` — `MAX_SCAN`, `TABLE_PRICE_USD`, `ARC_BUCKET_PRICE`, `clampCount`, `hederaScanPriceAtomic`, `hederaScanPriceUsd`, `arcBucket`, copied from the brief verbatim (no changes needed — see verification below).
- `packages/core/test/pricing.test.ts` — the brief's three tests verbatim, plus one added test per the team lead's resolution: `hederaScanPriceUsd(100)` must be `"0.051"` with no exponent notation.
- `packages/core/src/index.ts` — added `export * from "./pricing"`.

**Verification of the exponent-notation guard:** before writing the guard test, ran the brief's exact formula (`(1000 + 500*count) / 1e6).toString()`) in Node for every `count` in 1..100 (the `MAX_SCAN` range). No result used exponent notation, and `count=100` produces exactly `"0.051"`. So the brief's implementation needed no change — only the extra regression test.

**TDD evidence:**
- RED: `bun test packages/core/test/pricing.test.ts` → `error: Cannot find module '../src/pricing'`, 0 pass / 1 fail.
- Implemented `pricing.ts`.
- GREEN: `bun test packages/core/test/pricing.test.ts` → 4 pass, 0 fail, 15 expect() calls.

**Commit:** `7d288c3 feat(core): metered pricing for Hedera and bucketed Arc routes`

## Self-review (all three tasks)

- **Completeness against briefs:** every type/function/const listed in each brief's Interfaces block is present and exported from `src/index.ts`; `UnifiedVault` includes `chainId`, `inputTokenBalance`, `depositLimit` as flagged for Task 7's consumption.
- **Naming:** matches the briefs exactly (flag name literals, camelCase functions/types, `THRESHOLDS`/`ARC_BUCKET_PRICE` const casing).
- **YAGNI:** no code beyond what the briefs specify; the only additions beyond verbatim brief content are the one added pricing regression test and the deposit-limit formatting fix, both instructed by the team lead's resolutions section, not self-initiated scope.
- **Tests verify real behavior:** hand-traced all risk-engine cases against the window/threshold/weight tables (see above) rather than trusting pass/fail alone; confirmed the stale-data short-circuit is structurally independent of the numeric fields (early return before any parsing), so it cannot pass "by accident."
- **Pristine output:** grepped all new source and test files for `console.`, `TODO`, `FIXME`, `XXX` — none found.
- **Typecheck:** `bun x tsc -p packages/core/tsconfig.json --noEmit` clean (no output) after each of the three tasks.
- **Full suite:** `bun test` at repo root passes 47/47 across 9 files after Task 8 (37 after Task 6, 43 after Task 7), no regressions introduced to the pre-existing canonical/envelope/pq/receipts tests.

## Concerns

- Resolved by Fix round 1 below. The one substantive judgment call (formatting `deposit_limit_reached`'s `value`/`threshold` to 6 decimals rather than the brief's raw-string sample) is a small, test-invisible deviation made to satisfy the team lead's explicit output-format resolution; flagging it here so a reviewer can confirm that reading is correct.

## Fix round 1: deposit-limit precision loss (reviewer finding)

**Finding:** code review confirmed the concern flagged above was a real bug, not a benign deviation. `packages/core/src/risk.ts` (previously line 53) echoed the `deposit_limit_reached` flag's `value`/`threshold` via `fmt(bal)`/`fmt(lim)` — i.e. `Number(str).toFixed(6)` — instead of the brief's raw pass-through (`v.inputTokenBalance!`, `v.depositLimit!`). Beyond the spurious `.000000` suffix, this silently corrupts realistic atomic-unit balances (e.g. an 18-decimal token) once they exceed `Number.MAX_SAFE_INTEGER`.

**Confirmed with a reproduction before fixing** (not part of the test suite, just diagnostic):
```
$ node -e '
const bigBal = "123456789012345678901234567890";
const bigLim = "100000000000000000000000000000";
const balNum = Number(bigBal), limNum = Number(bigLim);
console.log("Number(bal) =", balNum, "-> fmt:", balNum.toFixed(6));
console.log("Number(lim) =", limNum, "-> fmt:", limNum.toFixed(6));
console.log("BigInt compare bal>=lim:", BigInt(bigBal) >= BigInt(bigLim));
console.log("Number compare bal>=lim:", balNum >= limNum);
'
Number(bal) = 1.2345678901234568e+29 -> fmt: 1.2345678901234568e+29
Number(lim) = 1e+29 -> fmt: 1e+29
BigInt compare bal>=lim: true
Number compare bal>=lim: true
```
The old code would have echoed `"1.2345678901234568e+29"` for `value` — exponential notation with digits 18+ truncated, not a decimal string at all. For this particular pair the `>=` comparison still happened to agree between `Number` and `BigInt`, but that's incidental to the magnitudes chosen, not a property of the comparison.

**Fix:**
- Reverted the flag's `value`/`threshold` to the brief's raw pass-through: `v.inputTokenBalance!`, `v.depositLimit!` (exact strings, no `fmt()`).
- Chose the BigInt option the team lead offered for the `bal >= lim` comparison: added `gteExact(a, b)` in `packages/core/src/risk.ts`, which compares via `BigInt` when both strings match `/^\d+$/` (the normal case for non-negative atomic-unit balances) and falls back to the existing `Number` comparison otherwise. A comment above it explains why (`bal`/`lim`'s `Number()` parsing elsewhere is fine for magnitude checks but not for this flag's compare-and-echo use). This closes the latent precision gap the reviewer flagged, rather than just documenting it.
- Added a covering test, `"deposit limit flag echoes exact atomic strings beyond Number.MAX_SAFE_INTEGER"`, in `packages/core/test/risk.test.ts` using the exact values from the review (`inputTokenBalance: "123456789012345678901234567890"`, `depositLimit: "100000000000000000000000000000"`), asserting the flag's `value`/`threshold` equal those raw strings exactly.

**Verification:**
```
$ bun test packages/core/test/risk.test.ts
bun test v1.3.10 (30e609e0)
 7 pass
 0 fail
 15 expect() calls
Ran 7 tests across 1 file. [77.00ms]

$ bun test
bun test v1.3.10 (30e609e0)
 48 pass
 0 fail
 98 expect() calls
Ran 48 tests across 9 files. [408.00ms]

$ bun x tsc -p packages/core/tsconfig.json --noEmit
(no output — clean)
```

**Files changed:** `packages/core/src/risk.ts`, `packages/core/test/risk.test.ts`.

**Commit:** `9b34c3e fix(core): echo raw deposit-limit strings instead of Number-rounding them`

**Concerns:** none. The fix is scoped to exactly the flagged lines; `bal`'s existing `Number()` parsing for the outflow ratio elsewhere in `computeRisk` is untouched since the reviewer's finding was specific to the deposit-limit flag's compare-and-echo path, not the outflow calculation.
