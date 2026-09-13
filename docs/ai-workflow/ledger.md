# SDD ledger, plan: docs/superpowers/plans/2026-09-09-vaultradar.md

Spec: docs/superpowers/specs/2026-09-05-vaultradar-design.md (binding authority).
Worktrees: .worktrees/core (branch ws/core) for packages/*, scripts/, skills/, docs; .worktrees/substreams (branch ws/substreams) for substreams/. Controller stays on main and merges after each clean review.

## Pre-flight rulings
- Ruling: work happens in .worktrees/<name> branches, not on main; merged to main after each task review, user is solo, asked to proceed, worktrees are their stated convention elsewhere, cost if wrong: an extra merge step per task.
- Ruling: parallel implementers are allowed only across the two disjoint worktrees (TS chain vs Rust substreams), the 4-day window needs it and the paths never overlap, cost if wrong: a merge conflict in a shared file such as .gitignore or README, resolved by hand.
- Ruling: tasks that need credentials the user has not supplied (Substreams token, Hedera/Arc accounts, Neon, Studio key) complete their offline steps and report DONE_WITH_CONCERNS; live steps are re-run when secrets arrive, cost if wrong: rework if a live API differs from the typed contract.

## Pre-flight conflict scan
| Tasks | Interface | Finding |
|---|---|---|
| 2 ↔ 3,5 | canonicalBytes/hashJson used by sign and receipts | consistent names |
| 3 ↔ 5,14,15 | attachSig/checkSig, deriveSigningKeys → pubHash | consistent |
| 4 ↔ 5,15,21 | Sealed, seal/open/isSealed | consistent; open() generic |
| 5 ↔ 15,21 | buildSealedRequest(request, payer, pk, now?) → {sealed, replySecret, count}; checkSealedRequest opts {now,payer,count,seen} | consistent |
| 6 ↔ 7,9,10 | UnifiedVault fields incl. inputTokenBalance, depositLimit, history.netFlowAssets | consistent |
| 8 ↔ 15,16,19,21 | hederaScanPriceUsd/Atomic, arcBucket, ARC_BUCKET_PRICE, TABLE_PRICE_USD, clampCount | consistent |
| 9 ↔ 15 | fetchStandardized(deployments, apiKey, heads, fetchImpl?) → {vaults, sources} | consistent; provider maps heads per chain |
| 10 ↔ 13 | vault_latest/vault_metrics/vault_meta columns; cursors table | column names match; cursors shape to confirm after sink setup (flagged in both tasks) |
| 14 ↔ 15,16,17,19 | Config.hedera.payToAccountId (fixed), usdcToken, facilitatorUrl, hcsTopicId; Config.arc.sellerAddress/network/facilitatorUrl; buildApp deps | consistent after fix |
| 15 ↔ 16,19 | HandlerDeps {getPayer,getTxId,rail,tier}; res.locals.receipt | consistent |
| 16 ↔ 17 | onSettled via res.json wrapper reading PAYMENT-RESPONSE | consistent |
| 18 ↔ 21 | readPqHash(chainId, agentId) → hex string; discover compares with card.pq.sig.pub_hash | consistent |
| 21 ↔ 22,23 | PaidResult, Discovery, Policy, Decision | defined once each |
| 21 test | setup described in prose referencing Task 14's test code | acceptable; implementer copies Task 14 setup |
| 16 | HBAR variant price comment | fixed to 0.01 HBAR per vault |

## Progress
Task 1: dispatched (base af97c09, worktree .worktrees/core, model haiku)
Task 11: dispatched (base af97c09, worktree .worktrees/substreams, model sonnet)
Task 1: review clean; trailer confirmed via git log; Ruling: `-c commit.gpgsign=false` is a no-op (no signing configured locally or globally), dropped from future dispatches, cost if wrong: none, commits are unsigned either way.
Task 1: minor (deferred, plan-mandated): root typecheck/verify-deployments scripts reference packages that later tasks create.
Task 1: complete (commits af97c09..c54b3a7, review clean), merged to main (ff)
Task 2: dispatched (base c54b3a7, worktree .worktrees/core, model haiku)
Task 2: implementer DONE (84a271b); review dispatched (sonnet)
Task 2: review spec, 2 Important (plan-mandated): (a) canonicalize() treats Date/Map/Set/RegExp/Error as plain objects → hashes to "{}" (collision); (b) fromHex() accepts non-hex chars → zero bytes. Ruling: adopt both guards (throw on non-plain objects; validate hex charset), the plan's sample code was under-specified and the spec requires deterministic, collision-free hashing, cost if wrong: none (stricter input validation only).
Task 2: minor (deferred): reviewer's remaining minor items truncated; re-check canonical.ts:9 Number.isInteger nuance in the final review.
Task 2: fix round 1/5 dispatched (resumed impl-task-2; fix base 84a271b)
Task 2: fix round 1 implemented (2a5e9fd); scoped re-review dispatched (sonnet)
Task 11: implementer DONE_WITH_CONCERNS (9799246): sql protodefs import dropped (protogen conflict under CLI 1.22); ethabi=17 added; package.url placeholder; live run skipped (no SUBSTREAMS_API_TOKEN). Ruling: Task 13 imports the substreams-database-change spkg (v1.3.x) for DatabaseChanges instead of the sql protodefs, and uses the matching crate, cost if wrong: Task 13 rework of the db_out output type. Review dispatched (sonnet).
Task 2: fix round 1/5 (2 addressed, 0 open; commits 84a271b..2a5e9fd)
Task 2: complete (commits c54b3a7..2a5e9fd, review clean after 1 fix round), merged to main (ff)
Task 3: dispatched (base 2a5e9fd, worktree .worktrees/core, model sonnet)
Task 11: review Approved; 1 Important (plan-mandated): ratio() unwrap_or_default maps unparseable amounts to zero. Ruling: carry the fix into Task 12 (ratio returns Option, unparseable events are skipped with a substreams log line) since Task 12 rewrites lib.rs around it, cost if wrong: one extra fix round in Task 12.
Task 11: minor (deferred): blanket #[allow(dead_code)] on mod pb; package.url placeholder pending the public repo; Cargo.lock/buf.gen.yaml/.last_generated_hash committed by judgment.
Task 11: complete (commits af97c09..9799246, review clean, 1 Important carried to Task 12), merged to main (merge commit), worktree fast-forwarded to main
Task 12: dispatched (base = main HEAD after merge, worktree .worktrees/substreams, model sonnet)
Task 12: base 9fdbe95 (main after Task 11 merge)
Task 3: implementer DONE (9eb9f08); review dispatched (sonnet)
Task 3: review spec (2+ Important, plan-mandated): (a) keys.ts:22 HKDF passes the domain tag as salt with info undefined; spec says info=vaultradar/kem/v1, Ruling: fix to hkdf(sha256, master, undefined, utf8("vaultradar/kem/v1"), need); (b) sign.ts:17 checkSig dereferences obj.sig before checking obj, Ruling: return false for non-objects. Awaiting the rest of the truncated report before fix round 1.
Task 3: minor (deferred → folded into fix round): kidOf duplication; KEM determinism assertion.
Task 3: fix round 1/5 dispatched (resumed impl-task-3; fix base 9eb9f08)
Task 3: fix round 1 implemented (6305597); scoped re-review dispatched (sonnet)
Task 3: fix round 1/5 (2 addressed, 0 open; commits 9eb9f08..6305597)
Task 3: minor (deferred): attachSig has no null guard (producer-side, non-adversarial); `lengths.seed ?? 96` fallback is dead code.
Task 3: complete (commits 2a5e9fd..6305597, review clean after 1 fix round), merged to main (merge commit)
Task 4: dispatched (base 6305597, worktree .worktrees/core, model sonnet)
Task 12: implementer DONE_WITH_CONCERNS (682d7c3): plan's self-referencing store_last_call is impossible in Substreams (store cannot depend on itself); replaced by per-vault phase throttle. Ruling: accept the phase throttle AND require an eth_call on first sight via store_vault_meta deltas, so every vault gets at least one exact total_assets reading, pre-review follow-up sent to impl-task-12, cost if wrong: slightly more RPC calls during backfill.
Task 4: implementer DONE (d28b842); review dispatched (sonnet)
Task 12: implementer DONE after follow-up (682d7c3, 5065a0d); review dispatched (sonnet)
Task 4: review spec, 1 Important: open() overloads break contextual-type inference; reviewer verified test-side fix. Ruling: revert to single generic (plan text), cost if wrong: none. Fix round 1/5 dispatched (resumed impl-task-4; fix base d28b842)
Task 12: review spec so far (truncated; remainder requested). Deferred note: share_price ratio is raw assets/shares without decimals normalization (per Task 11 contract); Task 15 provider should normalize erc4626 share price by 10^(share_decimals - asset_decimals) using vault_meta when present, cost if skipped: display-only scale error, drawdown ratios unaffected.
Task 4: fix round 1 implemented (169c5c1); scoped re-review dispatched (sonnet)
Task 12: review Approved with 2 Important (plan-mandated): (1) RpcBatch::execute never errs → failed calls written as zero "call" share price (load-bearing: risk engine would see 100% drawdown); (2) store_vault_meta re-calls every touch. Ruling: fix both now, per-response failed/None checks and zero-supply guard; marker store + deltas map so meta calls run once per vault; failed asset() means "not a real 4626 vault", no retry, cost if wrong: a genuine vault with a transient RPC failure is skipped until re-sync.
Task 12: minor (deferred): RpcBatch/HashSet shape duplicated between store_vault_meta and store_last_call; BigInt zero-fallback boilerplate.
Task 12: fix round 1/5 dispatched (resumed impl-task-12; fix base 5065a0d)
Task 4: fix round 1/5 (1 addressed, 0 open; commits d28b842..169c5c1)
Task 4: complete (commits 6305597..169c5c1, review clean after 1 fix round), merged to main
Task 5: dispatched (base 169c5c1, worktree .worktrees/core, model sonnet)
Task 12: fix round 1 implemented (de8df4c); scoped re-review dispatched (sonnet)
Task 5: implementer DONE (7be9b9a); review dispatched (sonnet)
Task 12: fix round 1/5 (2 addressed, 0 open; commits 5065a0d..de8df4c)
Task 12: complete (commits 9fdbe95..de8df4c, review clean after 1 fix round), merged to main; worktree synced
Task 13: dispatched (base = main HEAD after merge, worktree .worktrees/substreams, model sonnet)
Task 5: review spec (2 Important, plan-mandated): reply_pk base64 check is a no-op (lenient decoder); malformed-plaintext branch untested. Ruling: validate strict base64 + decoded length == ml_kem768_x25519.lengths.publicKey; field-named errors; tests for each malformed field, cost if wrong: none.
Task 5: minor (deferred): duplicated vaults cast; replay assertion reason (folded into fix); sweep untested (folded); generic error message (folded); empty-sources receipt untested.
Task 5: fix round 1/5 dispatched (resumed impl-task-5; fix base 7be9b9a)
Task 5: fix round 1 implemented (7a59bf6); scoped re-review dispatched (sonnet)
Task 5: fix round 1/5 (2 addressed, 0 open; commits 7be9b9a..7a59bf6)
Task 5: complete (commits 169c5c1..7a59bf6, review clean after 1 fix round), merged to main
Ruling: Tasks 6, 7, 8 batched into one implementer dispatch (three small independent core modules, one commit each, one combined review), saves two review cycles in a 4-day window, cost if wrong: a larger review diff to reason about.
Task 6+7+8: dispatched (base 7a59bf6, worktree .worktrees/core, model sonnet)
Task 6+7+8: implementer DONE (2f5e867, 129c535, 7d288c3); review dispatched (sonnet)
Task 6+7+8: review spec (1 Important): deposit_limit flag formatted via Number → precision loss for large atomic balances; deviation came from the controller's dispatch note. Ruling: revert to raw string pass-through (brief's code); comparison may use BigInt for integer strings, cost if wrong: none.
Task 6+7+8: minor (deferred): pricing no-exponent test rationale; hard-coded "0.200000" threshold string (plan-mandated).
Task 6+7+8: fix round 1/5 dispatched (resumed impl-task-6-8; fix base 7d288c3)
Task 6+7+8: fix round 1 implemented (9b34c3e); scoped re-review dispatched (sonnet)
Task 6+7+8: fix round 1/5 (1 addressed, 0 open; commits 7d288c3..9b34c3e)
Task 6+7+8: minor (deferred): outer deposit-limit gate uses Number()-parsed values for truthiness; negative depositLimit quirk (pre-existing semantics).
Task 6: complete; Task 7: complete; Task 8: complete (commits 7a59bf6..9b34c3e, review clean after 1 fix round), merged to main
Ruling: Tasks 9 and 10 batched into one dispatch (both are data-layer adapters producing UnifiedVault; one review), cost if wrong: larger review diff.
Task 9+10: dispatched (base 9b34c3e, worktree .worktrees/core, model sonnet)
Task 13: implementer DONE_WITH_CONCERNS (f95c1a0). Rulings: (1) substreams-database-change crate+spkg pinned to 2.1.1 (1.x/2.0 pin prost 0.11 → verified compile error), accepted; (2) vault_latest written with upsert_row (plan's update_row fails on first touch; verified against sink Go source and local Postgres), accepted, plan bug; (3) vault_latest keeps the last call-sourced total_assets across event-sourced touches (documented), accepted as "current state" semantics; (4) clippy not_unsafe_ptr_arg_deref allowed at Cargo [lints] level (macro-generated FFI wrapper), accepted; (5) cursors table confirmed as (id text PK, cursor text, block_num bigint, block_id text), Task 10 reader query stands. Note for Task 20/README: standalone substreams-sink-sql is deprecated in favor of `substreams sink postgres`; package.description still unset (cosmetic). Cost if rulings wrong: sink schema rework.
Task 13: review dispatched (sonnet)
Task 13: review Approved (0 Important). minor (deferred): duplicated NULL-skip block in db_out; crate-wide clippy allow broader than needed.
Task 13: complete (commits 0a24fb1..f95c1a0, review clean), merged to main. Substreams workstream offline-complete; live steps pending SUBSTREAMS_API_TOKEN + DATABASE_URL (commands in substreams/erc4626-vault-metrics/README.md).
Task 9+10: implementer DONE_WITH_CONCERNS (c9da8f9, 8198ced): SourceRef reused from receipts.ts (ruling: accepted, Task 15 imports from barrel); verify gate not run (no key); 7 extra yield entries added. Review dispatched (sonnet)
Ruling: third worktree .worktrees/service (branch ws/service, from 8198ced) for packages/service tasks so Task 14 can overlap the Task 9+10 review without two implementers sharing a checkout, cost if wrong: merge conflicts limited to .env.example / root package.json.
Task 14: dispatched (base 8198ced, worktree .worktrees/service, model sonnet)
Task 9+10: review spec with 2 Important (plan-mandated): (1) yield history netFlow diffs across the hourly/daily boundary; (2) cursor lookup LIKE '%chainId%' can cross chains. Rulings: (1) per-series diffs, oldest point null, merged history sorted desc; (2) per-chain cursor tables `cursors_<chainId>` via the sink's --cursors-table flag; reader takes head {ts, block} and derives age from block lag × BLOCK_TIME_S {1:12, 8453:2}; missing table → unavailable. Carry to Task 20/25: sink run commands and substreams README must add `--cursors-table cursors_1` / `cursors_8453`. Cost if wrong: reader/provider signature churn in Task 15.
Task 9+10: minor (deferred): mapper duplication; two `Meta` types; sequential per-vault history queries; ids are 44 chars (checklist said 46; brief examples are 44).
Task 9+10: fix round 1/5 dispatched (resumed impl-task-9-10; fix base 8198ced)
Task 14: implementer DONE (5859f36); note: @ts-expect-error guards on rails dynamic imports must be removed in Tasks 16/19. Review dispatched (sonnet)
Task 9+10: fix round 1 implemented (950fdd5); scoped re-review dispatched (sonnet)
Task 14: review spec (2 Important): router-wide cors() leaks onto later-mounted paid routes; async handlers without rejection handling. Ruling: path-scoped CORS + asyncHandler wrapper + JSON error middleware, cost if wrong: none.
Task 14: fix round 1/5 dispatched (resumed impl-task-14; fix base 5859f36)
Task 14: minor (deferred): no afterAll server close in test; /v1/receipts/:hash lacks 64-hex validation (fold into Task 17); PORT NaN guard; top-level test setup.
Task 9+10: fix round 1/5 (2 addressed, 0 open; commits 8198ced..950fdd5)
Task 9+10: minor (deferred): readSinkCursorBlock catch swallows all errors (should log unexpected ones).
Task 9: complete; Task 10: complete (commits 9b34c3e..950fdd5, review clean after 1 fix round), merged to main. Core workstream (Tasks 1-10) complete.
Task 14: fix round 1 implemented (97aa551); scoped re-review dispatched (sonnet)
Task 14: fix round 1/5 (2 addressed, 0 open; commits 5859f36..97aa551)
Task 14: minor (deferred): per-route cors() does not answer OPTIONS preflight; add router.options(path, cors()) if any browser client needs a preflighted request (check in Task 24).
Task 14: complete (commits 8198ced..97aa551, review clean after 1 fix round), merged to main
Task 15: dispatched (base cebd99c, worktree .worktrees/service, model sonnet)
Ruling: fourth worktree .worktrees/dashboard (branch ws/dashboard, from main f87b716) so Task 24 runs in parallel with Task 15; RunRecord shape fixed now (see Task 24 dispatch) and carried into Task 21, cost if wrong: bun.lock merge conflicts (resolve by re-running bun install) and a possible RunRecord mismatch caught in Task 21's review.
Task 24: dispatched (base f87b716, worktree .worktrees/dashboard, model sonnet)
Task 15: implementer DONE (4246e96) with concerns. Ruling: RPC-failure sentinel must be { ts: MAX, block: MAX } so sink sources also go stale, pre-review fix sent; accepted: per-chain over-reporting of sources in scan(), extra provider tests, fixture address fix, capMs + clearTimeout. Cost if wrong: none.
Task 24: implementer DONE_WITH_CONCERNS (f04d0f7): .gitignore runs/ anchored to /runs/ (accepted); pg aliased out of the browser bundle (accepted); Vercel deploy deferred to Task 25/26; run-id validation tightened (accepted). Review dispatched (sonnet)
Task 15: pre-review fix done (6872562); review dispatched (sonnet)
Task 24: review spec, 0 Critical, 0 Important (minors truncated in transit; none blocking). complete (commits f87b716..f04d0f7, review clean), merged to main. Vercel deploy deferred to Task 25/26.
Task 15: review Approved with 1 Important (coverage gap: sink-only merge branch untested). minor (deferred): duplicate local `count` names in scan.ts; table price derived from TABLE_PRICE_USD; RPC failures swallowed without logging; catalog vaultCount reads the 60s cache (accepted deviation).
Task 15: fix round 1/5 dispatched (resumed impl-task-15; fix base 6872562)
Task 15: fix round 1 implemented (e276265); scoped re-review dispatched (haiku)
Task 15: fix round 1/5 (1 addressed, 0 open; commits 6872562..e276265)
Task 15: complete (commits cebd99c..e276265, review clean after 1 fix round), merged to main; ws/service synced with main
Ruling: fifth worktree .worktrees/agent (branch ws/agent from main) for Tasks 21-23 in parallel with the rails.
Task 16: dispatched (worktree .worktrees/service, model sonnet); Task 21: dispatched (worktree .worktrees/agent, model sonnet)
Task 21: implementer DONE (10d8ff9); pq.sig.pubhash key confirmed consistent with Task 18 (PQ_KEY); zod peer warning noted for Task 23. Review dispatched (sonnet)
Task 16: implementer DONE_WITH_CONCERNS (58c493e): thrown price error → 500 in x402 middleware. Ruling: validate X-VR-Count and envelope shape in a plain middleware before paymentMiddleware (400 bad_count / malformed_envelope), pre-review fix sent; accepted: @x402/fetch added, main.ts wiring deferred to Task 17. Cost if wrong: none.
Task 16: pre-review fix done (64e4104); review dispatched (sonnet)
Task 21: review spec (3 Important; 2 plan-mandated): attestationsValid vacuous on empty; sealed flag reflects intent not reality (downgrade accepted); Arc non-200 guard dead and reason lost. Rulings: count+id match for attestations; reject sealed/clear mismatches; wrap Circle pay errors; injectable arcPay for tests. Carry to Task 19: service responses should include `error` alias next to `reason` so Circle's client surfaces it. Cost if wrong: none.
Task 21: minor (deferred): ensureDiscovery no in-flight dedupe; listRuns no shape check; AgentCardSchema arc.scan lacks passthrough.
Task 21: fix round 1/5 dispatched (resumed impl-task-21; fix base 10d8ff9)
Task 16: review spec (2 Important): settlement maps leak on settle failure; success path untested. Ruling: onSettleFailure cleanup + 10-minute sweep on insert; fake facilitator success mode with three tests, cost if wrong: none.
Task 16: minor (deferred): duplicated validation predicates; microtask-ordering argument only in a comment.
Task 16: fix round 1/5 dispatched (resumed impl-task-16; fix base 64e4104)
Ruling: sixth worktree .worktrees/docs (branch ws/docs from main 4dc9d8e) for Task 25 as a draft now (README, SKILL.md, demo.sh, standards-leverage.md) with explicit <<FILL:...>> markers for live URLs/tx ids to be filled at Task 26, uses idle time while the rails and agent fix rounds run; cost if wrong: a second docs pass to reconcile renamed commands.
Task 25: dispatched (draft; worktree .worktrees/docs, model opus)
Task 21: fix round 1 implemented (c44f098); scoped re-review dispatched (sonnet)
Task 16: fix round 1 implemented (381dadb); scoped re-review dispatched (sonnet)
Task 21: fix round 1/5 (3 addressed, 0 open; commits 10d8ff9..c44f098)
Task 21: minor (deferred → folded into Task 22+23 dispatch): attestation vaultIds must be distinct (bijection); sealed flag computed from observed response; receiptValid should also check request_hash/response_hash.
Task 21: complete (commits 4dc9d8e..c44f098, review clean after 1 fix round), merged to main
Ruling: Tasks 22 and 23 batched into one dispatch (policy + tools/CLI in the agent worktree; one review), cost if wrong: larger review diff.
Task 22+23: dispatched (base = main after Task 21 merge, worktree .worktrees/agent, model opus)
Correction: the "Task 21 merged to main" line above was premature (merge blocked by a dirty bun.lock on main); bun.lock restored and merge redone now.
Task 16: fix round 1/5 (2 addressed, 0 open; commits 64e4104..381dadb)
Task 16: complete (commits 4dc9d8e..381dadb, review clean after 1 fix round), merged to main; ws/service synced
Ruling: Tasks 17 and 18 batched (HCS queue + identity bootstrap, both service-side, one review), cost if wrong: larger review diff.
Task 17+18: dispatched (worktree .worktrees/service, model sonnet)
Task 25 (draft): implementer DONE_WITH_CONCERNS (5b66e9b): 13 markers/22 occurrences; architecture.md harness block removed + PNGs regenerated; substreams README fixed to --cursors-table; one-prompt recorded as skipped. Ruling: merge the draft to main now (docs-only, low risk) and defer its review to the fill pass after Tasks 17-23 merge and live values exist; dashboard README boilerplate to be replaced then, cost if wrong: an unreviewed draft on main for a day.
main: 1 failing test after docs merge (wellknown "skill.md 404s until Task 25 publishes it" now 200), routed to impl-task-17-18 to fix in ws/service (merge main first). Ruling: the 404 expectation was a placeholder; the correct assertion is 200 text/markdown plus a 404 case via an injectable skillPath.
Task 17+18: implementer DONE_WITH_CONCERNS (7f2dbe0, bb85376); rulings: onSettled composition accepted; readPqHash transport param accepted; live steps pending credentials. Review dispatched (sonnet). Skill.md test fix re-sent to impl-task-17-18 as a separate commit.
Task 22+23: implementer DONE_WITH_CONCERNS (e05c9f9, 728cdd6): Hedera signer network must be CAIP-2 "hedera:testnet" (fixed in agent; the service's hello-x402.ts still passes "testnet" per the plan, carry the fix into Task 19); applyAgeCheck accepts future timestamps (fold into fix loop if reviewer flags; else Task 26 pass); chat untested (scoped). Review dispatched (sonnet).
User request 2026-09-10: add user (portfolio) and admin dashboard views. Spec §13 and plan Tasks 27-28 added (promised scope vs labelled stretch). Ruling: Task 28's portfolio view + admin shell start now in .worktrees/dashboard against the §13.1 contract; Task 27 (service metrics) runs after Task 19 in the service worktree, cost if wrong: admin page wiring adjusted after Task 27 merges.
Task 28: dispatched (phased A/B/C; worktree .worktrees/dashboard at 3566f3b, model opus)
Task 17+18: skill.md test fix landed (8cb0658 merge main, 885c60e); implementer disclosed a stray bare command that ran in .worktrees/agent, controller verified agent worktree clean at 728cdd6, no merge in progress.
Task 22+23: review spec (2 Important): applyAgeCheck accepts future timestamps (plan-mandated), Ruling: bound both directions with CLOCK_SKEW_S=120; decide() citation txId lacks receipt fallback. Folded minors: strict-tier multi-chain silent drop → per-chain tables + explicit insufficient data; SERVICE_URL in .env.example. minor (deferred): watch.ts mixes formatting; chat untested (scoped).
Task 22+23: fix round 1/5 dispatched (resumed impl-task-22-23; fix base 728cdd6)
Task 17+18: duplicate skill-fix request was a no-op (fix already at 885c60e); ws/service merged main again (6f99a20). Awaiting the 17+18 review verdict.
Task 17+18: review spec (2 Important, plan-mandated): TopicMessageSubmitTransaction.execute returns only chunk 1 (sequence/timestamp mismatch vs mirror last-chunk convention), Ruling: executeAll, last chunk for sequence/timestamp, first chunk id as initial_transaction_id; readPqHash decodes non-UTF-8 to garbage, Ruling: fatal TextDecoder + /^[0-9a-f]{64}$/ or null. Folded minor: metadataArgs helper.
Task 17+18: fix round 1/5 dispatched (resumed impl-task-17-18; fix base 6f99a20)
Task 17+18: fix round 1 implemented (68ede9a); scoped re-review dispatched (sonnet)
Note: skill.md test-fix commit 885c60e (test + skillPath dep) sits outside every task review range; flag it for the final whole-branch review.
Task 22+23: fix round 1 implemented (b6ce4c1) incl. multi-chain fan-out budget fix; partial-failure across chains documented; scoped re-review dispatched (sonnet)
Task 17+18: fix round 1/5 (2 addressed, 0 open; commits 6f99a20..68ede9a)
Task 17+18: minor (deferred): redundant getReceipt before getRecord; packages/agent/src/erc8004.ts has the same non-fatal decode pattern (route to next agent fix round).
Task 17: complete; Task 18: complete (commits ee01231..68ede9a, review clean after 1 fix round), merged to main
Ruling: Tasks 19 and 27 batched (Arc rail + metrics endpoint; 27 consumes 19's Arc settlement hook; one review), cost if wrong: larger review diff.
Task 19+27: dispatched (worktree .worktrees/service, model sonnet)
Task 22+23: fix round 1/5 (4 addressed, 0 open; 1 new Important: paid-chain decisions discarded on later-chain verification failure; commits 728cdd6..b6ce4c1)
Task 22+23: minor (deferred): tools' top-level receipt_hash/tx_id describe payment 1 while price_usd sums all (note field mitigates); missingVaultDecisions cites empty block/source.
Task 22+23: fix round 2/5 dispatched (resumed impl-task-22-23; fix base b6ce4c1) incl. agent erc8004 decode fix and quote fan-out count
Task 22+23: fix round 2 implemented (7998216); scoped re-review dispatched (sonnet)
Task 22+23: fix round 2/5 (3 addressed, 0 open; commits b6ce4c1..7998216)
Task 22: complete; Task 23: complete (commits 728cdd6..7998216, review clean after 2 fix rounds), merged to main. Agent workstream complete (chat untested; watch fully tested).
Correction: Task 22+23 merge hit an .env.example conflict; resolved by union and committed as the merge commit above.
Note: .env.example union during the agent merge kept every name but lost the docs-branch grouping/comments; Task 26 fill pass must re-reconcile it (dedupe, regroup, comment).
Task 28: implementer done Phases A+B (18c006d, 274a76b), Phase C skipped (no vault-list endpoint; Task 27 adds /v1/vaults). Phase B used the fallback local decide mapper because policy.ts was not on main yet. Ruling: pre-review swap to the real agent helpers + budget enforcement (over_budget) before review; admin page to be verified against the real metrics endpoint after Task 19+27 merges, cost if wrong: one extra round.
Task 28: final DONE_WITH_CONCERNS (35c6efe): real policy helpers + budget enforcement; stretch items none; root typecheck red at packages/agent/test/harness.ts:106 (TS2740, from Tasks 22-23), routed to impl-task-22-23; .env.example lost CHROME_BIN/DIAGRAM_SCALE (render-script vars; restore in Task 26 pass). Review dispatched (sonnet) over 39c4db9..35c6efe.
Task 28: extra commit 67e4c2c (over_budget code, per-scan ceiling guard, .env.example union restoring 9 names incl. DEPLOYER_KEY_* and LIVE) landed after the review package (base..35c6efe); include 35c6efe..67e4c2c in the scoped re-review after the current review. Note: main .env.example is missing 9+ names, take the dashboard branch version at merge.
Task 19+27: implementer DONE (9fe94f8, db4ceb4): Circle middleware settles BEFORE the handler (plan assumption wrong) → onSettled wired from a handler wrapper; @x402/evm added as explicit dep (eager import in Circle's server entry); real GatewayClient offline paid-path test. Ruling: on Arc, ts/nonce/count checks must run pre-payment; payer-mismatch after settlement is a documented, unrefunded limitation (README boundary). Review dispatched (sonnet).
Agent typecheck fix (774931a) verified (agent tsc clean, 73 tests) and merged to main without a task review, Ruling: test-only typing change, covered by the final whole-branch review, cost if wrong: none.
Note: the agent typecheck fix (774931a, merged a639b26) also changed packages/service (HcsSink interface implemented by HcsQueue; buildApp hcs typed as HcsSink) and fixed a real agent bug (LookupResult.sequence is a string; pollHcs accepted only numbers). Flag both for the final whole-branch review; ws/service must merge main before its next merge (possible app.ts conflict).
Task 28: review Approved in substance (3 Important at 35c6efe, all verified fixed in 67e4c2c by the same reviewer reading the commit), Ruling: accept that as the scoped re-review. minor (deferred): large single files (scan.ts, ScanForm.tsx, admin/page.tsx); .env.example comment overstates /admin behaviour.
Task 28: complete (commits 3566f3b..67e4c2c), merged to main (dashboard .env.example taken as the superset). Pending joint pass: /admin against the real metrics endpoint once Task 19+27 merges.
Task 19+27: review spec, Important #1: pre-payment ordering ruling only partially applied on Arc (ts/nonce/envelope/count checks still run post-settlement); #2 and #3 truncated, resend requested. ws/service merged with main ahead of the fix round.
ws/service: merge of main aborted (env conflict + admin.ts typed against HcsQueue while main uses HcsSink); the Task 19+27 fix round must merge main first and reconcile HcsSink (add stats() to the interface).
Task 19+27: review findings: #1 pre-payment split on Arc (ruling: core envelope split into pre-payment / payer / commitNonce phases; Arc pre-middleware opens the envelope and stashes it; payer_mismatch post-settlement documented as unrefunded); #2 recordSettlement unguarded and outside try blocks (ruling: validate, no-op on bad input, move inside try); #3 HBAR tinybars summed into USDC revenueAtomic (ruling: count but do not sum HBAR-asset settlements; keep §13.1 shape; README caveat later). Folded: hoist onSettled closure; cross-package isAdminMetrics test. Fix round must merge main first and reconcile HcsSink (add stats()).
Task 19+27: fix round 1/5 dispatched (resumed impl-task-19-27; fix base db4ceb4)
User request: merge all worktrees to main and clean. Removed worktrees+branches core, substreams, docs, agent, dashboard (all ancestors of main, clean). ws/service retained: Tasks 19+27 fix round in progress; merge + clean after its re-review.
Task 19+27: fix round 1 implemented (8cccb6e merge+compile fixes, b76f5c5 fixes); integer-only amount validation accepted (Arc amounts are atomic strings); scoped re-review dispatched (sonnet)
Task 19+27: addendum commit 9cd3540 (admin.ts comment only) after the re-review package; include in merge.
External review verified (2026-09-10 ~05:00): 4 critical confirmed (1 already fixed on ws/service), medium items confirmed; plan Task 29 (hardening) added; docs corrections fold into the fill pass.
Task 19+27: fix round 1/5 (3 addressed + folded, 0 open; commits 8cccb6e..9cd3540). minor (deferred): Arc check-then-commit nonce gap under concurrent identical paid requests (no fund loss); report should mention 9cd3540.
Task 19: complete; Task 27: complete, merged to main. All six worktrees merged and removed (user request). New worktree .worktrees/hardening (ws/hardening) for Task 29.
Task 29: dispatched (worktree .worktrees/hardening, model opus)
Task 29: implementer DONE_WITH_CONCERNS (4f7392c, 4369637, d15900c, 82af33a): spec §5.5 table price amended with a dated note (accepted); extra files lib/onchain.ts and verify-deployments.test.ts (accepted); viem added to dashboard (accepted). Review dispatched (opus).
Ruling: the session's primary directory is .worktrees/hardening and the harness now refuses git operations against the shared main checkout. Remaining work (Task 29 fix loop, docs fill, final-review fixes) stays on ws/hardening in this worktree; main receives ONE final merge run by the user (`git -C /Users/rahuljaguste/pq/ethonline-20206 merge --no-ff ws/hardening`). No circumvention via push/config, cost if wrong: main lags ws/hardening until the user merges.
Task 29: review spec, 4 of 8 fixes compliant; spend ledger has two defects, /verify anchor arm bypassable, verify-gate comparison inert against the real gateway; details requested (truncated).
Task 29: review Important #1-5: ledger check-then-pay race (reserve-then-adjust); proxy key first-entry (take from the end with TRUSTED_PROXY_HOPS); ledger records payee-controlled receipt price (max with quote); /verify trusts unsigned card identities and passes on empty (use receipt's signed ids; empty = unproven); repoint comparison inert (compare via subgraph-id endpoint). Fix round 1/5 dispatched (resumed impl-task-29; fix base 82af33a). Tail of the review (post-#5) requested.
Task 29: no Important beyond #5; minors #6-#11 noted; folded into fix round: Arc pre-payment ceiling via Circle abort hook; ledger/limiter singletons on globalThis; stale 0.03 comments. Deferred minors: microToUsd display rounding; Hedera clear-count test asserts one verify call (unavoidable); three micro-USD helpers.
Task 29: fix round 1 implemented (96a0074 five findings; ae54a8d addendum: Arc ceiling hook, globalThis state, comments); scoped re-review dispatched (opus)
Task 29: fix round 1/5 (7 addressed, 0 open; commits 82af33a..ae54a8d). Low: watch.ts:148 comment draws the wrong conclusion. minor (deferred → final fix wave): discover() timeout in the dashboard route (reservation held while a service hangs); Arc hook should register even for a "0"/empty quote (fail closed); watch.ts comment.
Task 29: complete (commits cf5fdc1..ae54a8d, review clean after 1 fix round), on ws/hardening; main merge pending user command.
Final whole-branch review: package c4c3b2c..ae54a8d generated; dispatching (opus).
Final review: report truncated after Critical #1 (unbound ERC-8004 anchor: client.ts:261 compares on-chain hash to self-asserted card.pq.sig.pub_hash; identityRefusal and dashboard lib/scan.ts:281 refuse only on matches===false, so empty erc8004 / null proceeds). Verified in code 2026-09-10; remainder of the report requested from final-review. Fix-wave BASE = ae54a8d.
Ruling: commit 31b023e (merge of main into ws/dashboard) lacks the Claude-Session trailer; left as is, it is a merge commit already in main's shared history and rewriting it is out of scope, cost if wrong: one commit without attribution trailer.
Final review (resend 1): Important #2 tvl_outflow_24h double-counts merged hourly+daily series (risk.ts:56, map.ts:47-50/76-79), verified; Important #3 scan-hbar receipt states micro-USDC/usdcToken for a tinybar payment (hedera.ts:237-242 vs handlers/scan.ts:189-205), verified; Important #4 README lines 12/152/219 call shipped components unbuilt, verified. Reply truncated again at Important #5; asked the reviewer to write the full report to the worktree-local SDD dir (final-review-report.md). Brief drafted at .worktrees/hardening/.superpowers/sdd/2026-09-09-vaultradar/final-fix-brief.md (F1-F7 so far).
Final review complete (report at .worktrees/hardening/.superpowers/sdd/2026-09-09-vaultradar/final-review-report.md): C1 anchor unbound; I2 outflow double-count; I3 scan-hbar receipt; I4 README understates; I5 deployments unpinned vs README:68; I6 dashboard persists decisions from an unverified receipt; I7 quote() is local not a 402 probe; 13 minors; verdict 'ready to merge with fixes'. All Important findings verified at their cited lines.
Ruling: I5, reword README:68 now (pins populate only when the verify gate runs with a Studio key); the gate stays the first credential-dependent step, cost if wrong: none, README re-corrected after the gate run.
Ruling: I7, document rather than implement the live 402 probe (per-rail ceilings already enforce the 402 demand; receipt price re-checked); spec §5.6 gets a dated amendment like §5.5, cost if wrong: a judge notes quoting is local; no security impact.
Ruling: minors fixed now: unknown-protocol table 422 pre-settlement, admin token constant-time compare, NaN sharePrice -> unavailable, dashboard in root typecheck, reader.ts warn on unexpected DB errors, policy.ts comment, demo.sh header, .env.example HEDERA_NETWORK + ADMIN_TOKEN comment, dashboard README /admin exposure note. Left (accepted): chainCache 60 s bounded staleness after head-RPC failure (deviation from §7, bounded to one TTL); module-level Hedera correlation maps; canonical 1e21 exponent form; large dashboard files; Arc nonce check-then-commit gap.
Ruling: the reviewer's triage defers the discover() timeout and the watch.ts comment; both stay in the wave anyway (small, already flagged fix-before-merge), cost if wrong: a few extra lines of review.
Final fix wave: brief at .worktrees/hardening/.superpowers/sdd/2026-09-09-vaultradar/final-fix-brief.md (F1-F10); BASE ae54a8d; dispatching a fresh implementer (final-fix, opus) rather than resuming impl-task-29, the brief is self-contained and the wave spans all four packages.
Final fix wave: implementer DONE_WITH_CONCERNS, 14 commits ae54a8d..1d0ac83 (F1 438dc81, F2 5ebdc6c, F3 2422c2f, F4 ce7c113, F5 43cd57f, F6 c6cad98, F7 012399a, F8 979ff06, F9 d546c62, F10a 882f34a, F10b 14f6ba0, F10c 9542230, F10d b9ae95f, F10e 1d0ac83); reported bun test 443 pass / 1 skip, typecheck (now incl. dashboard) exit 0, dashboard build exit 0. Report: .worktrees/hardening/.superpowers/sdd/2026-09-09-vaultradar/final-fix-report.md.
Ruling: F2 implemented as a timeout race (socket not torn down; reservation released and 502 returned) instead of a fetchImpl wrapper because tests inject their own client, accepted; cost if wrong: one abandoned socket per hung discovery.
Ruling: F10c treats a blank sharePrice as unreadable (Number('') is 0) in addition to non-finite, accepted under spec §5.3 'no verdict from partial data'.
Note: next build emits four pre-existing 'Dynamic filesystem access' warnings from packages/dashboard/lib/runs.ts (deploy-size only; untouched by the wave; for the fill/deploy pass).
Final fix wave: scoped re-review dispatched (rereview-final-fix, opus) over review-ae54a8d..1d0ac83.diff; controller running bun test in parallel.
Controller verification at 1d0ac83: bun test 443 pass / 1 skip / 0 fail (444 tests, 41 files); bun run typecheck exit 0 (core, service, agent, dashboard).
Controller verification at 1d0ac83: dashboard build exit 0 (pre-existing 'Dynamic filesystem access' warnings only).
Final fix wave: scoped re-review (1d0ac83), all F1-F10e ADDRESSED, no new Critical/Important breakage; 14/14 trailers; focused tests 206 pass. Minor (documentary): with ERC8004_*_AGENT_ID unset the card lists no identity and every paid run now refuses (by design, spec §3 threat 5); paid runs also need one successful on-chain read, state this in .env.example and README.
Ruling: controller adds the identity-prerequisite sentence to .env.example and README directly (docs-only, no code), cost if wrong: none.
Ruling: parked (post-merge polish, not blocking): Arc clear table body with a non-string protocol settles before the 422 (self-inflicted malformed request, USD 0.06); F5 hourly series spans ~23 h because the oldest hourly point has a null flow (documented nuance, daily fallback is coarser); dead applyAgeCheck call on the dashboard failure path.
Ruling: the SDD workspace is NOT deleted yet, plan Tasks 25 (docs fill) and 26 (video/submission) remain blocked on credentials; the ledger stays as the recovery map until they finish.
Controller commit 126c710 (docs only): .env.example + README state that an unregistered ERC-8004 identity, or an unreadable registry entry, refuses every paid run. Tree clean.
BRANCH COMPLETE: ws/hardening at 126c710 (cf5fdc1..126c710 = 16 commits). Gates at 1d0ac83/126c710: bun test 443 pass / 1 skip / 0 fail; typecheck exit 0 (core, service, agent, dashboard); dashboard build exit 0. Plan Tasks 1-19, 21-24, 27-29 complete. Remaining and credential-blocked: Task 20 (deploy), Task 25 (fill pass: 16 <<FILL>> markers, .env.example regroup, verification log), Task 26 (video + submission). Final integration step is the user-run merge: git -C /Users/rahuljaguste/pq/ethonline-20206 merge --no-ff ws/hardening
Headless-Chrome end-to-end run (2026-09-10, first browser test of the project): service booted on throwaway local PQ seeds + placeholder payTo, dashboard served from the existing next build, Chrome 152 headless over CDP. Pages driven: / (card, catalog 15 rows, runs), /verify (genuine receipt -> UNPROVEN with valid signature; tampered receipt -> NOT verified), /portfolio (vault parse, spend allowance, free history, scan disabled with keys-missing copy), /admin (bearer-authenticated live metrics), /runs/demo-run-1 (verdicts, decisions, explorer links). Zero console errors and zero page exceptions on all five; the only failed requests are Next RSC prefetch aborts that returned 200. Wire checks: /hedera/v1/scan 402 quotes 2500 micro-USDC for 3 vaults; /hedera/v1/scan-hbar 402 quotes 3000000 of asset 0.0.0 (the F6 fix visible on the wire); Blocky402 testnet facilitator answered with a live feePayer 0.0.7162784. POST /api/scan without agent keys returns 503 agent keys not configured.
UI findings from the browser run (not fixed, reported to the user): (1) /admin renders three raw Unix epochs (totals since <epoch>, Started at, Checked at); (2) packages/dashboard/public/demo-run.json prices the Arc table at 0.03 while TABLE_PRICE_USD and the card say 0.06; (3) textarea on /verify and /portfolio keeps the browser-default white background against the dark theme.
Browser-found fixes committed: epochUtc in packages/dashboard/lib/format.ts (six raw epochs on /admin now UTC instants, 5 tests incl. a TZ-independence test); demo-run.json table price 0.03 -> 0.06 with a new test pinning the fixture to TABLE_PRICE_USD/hederaScanPriceUsd; globals.css gives textarea/input/button the theme colours and :root declares color-scheme light dark. Gates: bun test 449 pass / 1 skip / 0 fail; typecheck exit 0; dashboard build exit 0. Re-verified in headless Chrome on /admin, /verify (dark and light), /portfolio, /runs/demo-run-1, no console errors.

--- 2026-09-11 session (merge, credentials, deploy) ---
Merge: the main checkout held a second, uncommitted hardening lineage (PgNonceStore, defensive BigInt mapping, HCS TTL, re-implementations of the same anchor/rail fixes). Preserved it on ws/maintree-hardening (3a5beb7, no attribution trailer per the user's newer instruction), then merged ws/hardening into main (80444ce), clean, since main was exactly the merge base.
Ruling: re-applied only the self-contained win from that lineage (toBigInt in map.ts, 2ad345d) and deferred PgNonceStore, it is async while the reviewed NonceStore interface is deliberately synchronous, so adopting it would refactor the pre-payment check path the final review certified, for a benefit that needs more than one service instance. Cost if wrong: no cross-instance replay protection while the service runs more than one
instance. The branch that held it was later deleted as clutter, 144 files behind main and
duplicating fifteen superseded fixes, so the design is recorded here instead: a NONCE_SEEN
table keyed by nonce with an expiry, claimed by a single `INSERT ... ON CONFLICT DO UPDATE ...
WHERE expires_at <= now` so the claim is atomic across instances, compared against the
database's own clock rather than any one instance's, created by an explicit `init()` at boot so
a misconfigured database fails there rather than on the first paid request, and given the same
SQL connection the sink reader already uses. Adopting it means widening NonceStore to allow
promises and awaiting it in the pre-payment path.
Fixed en route: vi missing from main's node_modules (bun install); five provider tests assumed the unpinned registry (fixture URL hardcoded /subgraphs/id, catalog status "unverified", aave-v3/base now "down" and skipped by fetchStandardized), 4cbd2a1; two unguarded sink reads 500ing requests against a database that exists but was never set up (faac7f7, d2eabab).
Verification gate: ran with the Studio key, 14/15 pinned; 11 live, 1 stale, 3 down (convex-finance and aura-finance last indexed years ago; aave-v3/base has no allocations), 3c4d966.
Deploy (Railway, per the user's choice): project vaultradar with Postgres, vaultradar-service, vaultradar-dashboard, vaultradar-sink. Service and dashboard live and green: https://vaultradar-service-production.up.railway.app and https://vaultradar-dashboard-production.up.railway.app. Dockerfiles for both services + the sink, plus .dockerignore (689711a, 6814534, 04d5c28).
  - Dashboard build fails on Linux under bun ("Expected CommonJS module to have a function wrapper, this is a bug in Bun") but succeeds via the image's node shim; Dockerfile prefers node and falls back to bun.
  - The sink's DSN must be rewritten postgresql:// -> postgres:// (its driver's allowed schemes are [psql postgres clickhouse parquet]); sed inside the Docker CMD did not survive JSON escaping, a POSIX case does.
  - .spkg files were gitignored, so `railway up` never shipped them to the build context; the two packed modules are now committed (689711a).
Identity: generated real PQ seeds (the .env still held the example comments) and registered on Hedera, HCS topic 0.0.10483981, ERC-8004 agent id 112, tx 0x0f23d2a0c2c3a820e69e4304027f5d442c6ae4a8cff1147a6ea8b4e5bda9ca3a. Arc skipped: no DEPLOYER_KEY_ARC.
Verified against production: the agent's own discover() returns cardSignatureValid true, keyBindingValid true, and onChain [{296, 112, matches: true}]; the registry read returns exactly the card's pub_hash (dd4a56bffd570c901648dcac7261d5bc38c079a139f3bc0e26c619a138cbf2e1).
Blocked, all needing the user: (1) SUBSTREAMS_API_TOKEN in .env is a 39-char placeholder, not a Market JWT, the sink is deployed with its schema applied and fails auth; (2) the agent Hedera account is now associated with HTS USDC but holds 0 USDC (Circle faucet) and the service payTo account 0.0.10463666 is not associated and its key is not in .env, so no settled payment yet; (3) no Arc deployer key or agent Arc key. Remaining README markers: 11, being the video, the two settled-payment links, the substreams.dev package URL, and their track-table duplicates.

--- 2026-09-11 late / 2026-09-12 early: Arc rail live, and the bug that was blocking it ---
Sink: the token in .env was a placeholder; with a real Market JWT the sink streams (verified: 105k rows, ~50 blocks/s, cursor climbing toward head 25,957,000). Its DSN must be rewritten postgresql:// -> postgres://; sed inside the Docker CMD did not survive JSON escaping, a POSIX case does.
Arc keys: there is no Arc key portal, Arc testnet is EVM, so keys are generated. Generated one keypair for the deployer+agent roles (0x80e24337503CBF24f7b2e3ba91b99D42C9E3583C, funded 20 USDC by Rahul), and a separate seller keypair (0x7bf9d000e847D634334d73C421BD4A6d40cB6bA5) whose address the service advertises and whose key lives in .env as ARC_SELLER_KEY (nothing reads it). ARC_SELLER_ADDRESS in .env had been the literal placeholder "0x...", so the deployed service advertised an Arc rail that paid nowhere.
Ruling: identity.ts is now idempotent (skips a chain whose AGENT_ID_ENV is already set), register() mints a new agent id per call, and re-running after registering one chain would have minted a duplicate on the other. Commit d191b8d.
Arc registered: agentId 894342, tx 0x0ebaa26f... Both on-chain anchors verified matching the card (296/112 and 5042002/894342).
CRITICAL BUG FOUND AND FIXED (b755885): checkSealedRequestPayer compared the sealed request's payer against the rail's payer byte-for-byte. viem hands the client a checksummed address; Circle Gateway reports the settled payer lower-cased. Every Arc payment therefore failed payer_mismatch, after settlement, on a rail with no refund path (README documents payer_mismatch as an Unrefunded limitation of Circle's design; in fact it fired on every request because of case). Found only by running a real payment and printing what the rail put on the request; both sides were correct in isolation. Fixed by lower-casing both sides; the comparison still rejects a wrong address.
Arc payment now settles end to end against production: deposit 2 USDC into Gateway (approval 0xcb3e84eb..., deposit 0xe253e739...), then 0.003 USDC for a sealed scan, receipt ok, sealed reply opened, batcher reference cbc2021d-d57e-4e05-b43f-56707a532f33. README updated with this and with both anchors.
HCS trail verified end to end: topic 0.0.10483981 carries the commitments (chunked, ML-DSA sigs exceed the message limit) and the deployed service's /v1/receipts/50bddf81... returns sequence 10 with its consensus timestamp.
Still blocked: the Hedera rail cannot settle, the agent's Hedera account 0.0.10463726 holds 0 USDC (needs Circle's faucet) and the service's payTo 0.0.10463666 is not associated with token 0.0.429274 and its key is not in .env. Remaining README markers: 8 (video, Hedera settled request, its track-table duplicate, and the substreams.dev package URL + duplicate).
