# Task 25 report: README, SKILL.md, demo script, standards leverage

Branch `ws/docs`, worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/docs`.
Commit `5b66e9b` "docs: README, SKILL.md, demo script, standards leverage (draft with fill markers)".

## What I wrote

**`README.md`** (226 lines, under the 350 cap). Nine sections in the order the brief
specified: pitch and track table; architecture with both PNGs embedded and a link to
`docs/architecture.md`; payment flow on Hedera numbered 1 to 8 exactly as spec §6, with
the Arc rail expressed as the deltas to steps 3 to 7; "What the standards made easier";
freshness and the two-sided refusal rule; privacy and post-quantum with the §3 boundary
statement quoted verbatim as a blockquote; run instructions; prize mapping plus honest
scope notes; license and session link.

Facts in it are read off the code, not the spec, wherever the two could differ: prices
from `packages/core/src/pricing.ts`, thresholds from `packages/core/src/unify/freshness.ts`,
the refusal rule from `packages/core/src/risk.ts`, envelope fields from
`packages/core/src/envelope.ts`, receipt shape from `packages/core/src/receipts.ts`,
route paths from `git show ws/service:packages/service/src/rails/hedera.ts`, discovery
from `git show ws/agent:packages/agent/src/client.ts`, package versions from the four
`package.json` files.

**`skills/vaultradar/SKILL.md`** (186 lines). Frontmatter is exactly the `name` and
`description` given. Body covers when to use, discovery with both the card-signature and
the ERC-8004 `getMetadata` key-binding check, the envelope fields and the four service-side
checks, the 402 flow per rail with exact package names at exact versions
(`@x402/fetch`/`@x402/hedera`/`@x402/core` 2.25.0, `@circle-fin/x402-batching` 3.4.0,
`@noble/post-quantum` 0.7.1), a five-step verification order for the response, the
agent's own freshness duty, the price table, the full error table, and an unpaid `curl`
that decodes the 402 header.

Verified: `wellknown.ts` serves this file at `/skill.md` from
`join(import.meta.dir, "..", "..", "..", "skills", "vaultradar", "SKILL.md")`. I resolved
that path against the new file and it exists.

**`scripts/demo.sh`** (executable, `set -euo pipefail`, `bash -n` clean). Eight echoed
headings: service under test, the signed card via `jq`, the unpaid 402 decoded, a paid
Hedera scan on the balanced policy, the same on a strict policy for the table tier, the
Arc `hello-arc` client, the receipt lookup, and the HCS mirror-node and HashScan topic
URLs. Steps 3 to 5 drive Tasks 19, 22 and 23, which do not exist yet. Rather than
aborting under `set -e`, a `run_or_show` helper runs the command when its entrypoint file
exists and otherwise prints the exact command with a "not built yet" note. A header
comment says so explicitly, and the commands are written as the contract those tasks
implement.

I ran the script end to end against a real service instance and it exits 0.

**`docs/standards-leverage.md`** (61 lines). Before-and-after for The Graph judges, with
two comparison tables: per-protocol integration versus standardized schema, and per-chain
module versus parameterized module. Concrete numbers throughout are derived from the repo
(two templates, 15 deployments, 10 protocols, 5 chains, one WASM binary, two manifests).

**`.env.example`** rewritten as one grouped, commented file. Every name from the previous
version is preserved (verified by set difference: zero removed). 16 names added, gathered
by grepping `process.env.` and `env.<NAME>` across `packages/` and `scripts/` on all six
branches: `SUBSTREAMS_API_TOKEN`, `RPC_URL_10`, `RPC_URL_137`, `SERVICE_URL`,
`AGENT_HEDERA_ACCOUNT_ID`, `AGENT_HEDERA_KEY`, `AGENT_ARC_KEY`, `ANTHROPIC_API_KEY`,
`POLICY_PATH`, `VAULT`, `DEPOSIT`, `NEXT_PUBLIC_SERVICE_URL`, `DEMO`, `LIVE`, `CHROME_BIN`,
`DIAGRAM_SCALE`. Names read only by a not-yet-built task are marked `(designed)`.

## Two files I changed that were not in the deliverable list

**`docs/architecture.md` and both PNGs.** The system diagram contained a
`hedera-dev/hedera-harness PR` subgraph with the Tier 3.5 `x402Probe` validator. That is a
cut item, and the README embeds `architecture.png`, so shipping it would have made the
README claim the cut work visually while the prose disclaimed it. I removed the subgraph
and its edge, added a line saying both diagrams show the designed system and that the
harness was cut, linked the two PNGs, and regenerated both with
`node scripts/render-diagrams.mjs`. I checked the new PNG: the harness box is gone.
Task 25's own brief lists `docs/architecture.md` under "Modify", so this is in scope.

**`substreams/erc4626-vault-metrics/README.md`.** See the disagreement below.

## Where the code and the docs disagreed

**Cursor table name. Code wins.** The Substreams package README (Task 13) said the sink
creates a single `cursors` table and instructed: "If a query elsewhere in this project
reads sink progress directly from Postgres, point it at `cursors`, not a differently-named
table." That is the opposite of what shipped.
`packages/core/src/substreams/reader.ts:31` reads `SELECT block_num FROM cursors_${chainId}`,
and `packages/core/test/reader.test.ts` plus `packages/service/test/live-data-provider.test.ts`
assert on `cursors_1` / `cursors_8453` / `cursors_10`. The team lead's brief also called for
`--cursors-table cursors_1` / `cursors_8453`.

I followed the code. Two shipped docs contradicting each other on an operational flag is a
live footgun for whoever runs the sink, so I fixed the package README rather than only
noting it: the setup step is now run once per chain with `--cursors-table`, both run
commands carry the flag, and the "Cursor table" paragraph now says why the default must not
be taken and points at `reader.ts`. I also converted its `<TODO: substreams.dev URL after
publish>` to the `<<FILL: ...>>` marker syntax so a single grep finds every unknown.

**`substreams sink postgres`.** I verified against the installed CLI rather than assuming.
`substreams` 1.22.0 does ship the sink built in. Both `substreams sink postgres` and
`substreams-sink-sql run` accept `--cursors-table`; the built-in form takes the connection
string as `--dsn` instead of a positional argument. Documented in both READMEs in that form.

**One-prompt Substreams.** The brief called it "attempted only as a recorded prompt".
`docs/one-prompt.md` says **Status: skipped** and the module was hand-built. I followed the
file: the README says the generation was not run, that the plugin install was out of scope,
and that the exact prompt plus a real blocker are recorded there. Nothing claims an attempt
that did not happen.

**`hello-arc.ts` does not exist.** `packages/service/scripts/hello-x402.ts` exists on
`ws/service`; `hello-arc.ts` is Task 19 step 2 and is unwritten. `demo.sh` uses the
`hello-arc.ts` path the brief specified, guarded by `run_or_show`.

**Boundary statement.** Quoted byte-for-byte from spec §3, semicolon included, despite the
no-semicolon house style. It is a quotation.

## Every `<<FILL: ...>>` marker

13 distinct unknowns, 22 occurrences.

| Unknown | Locations |
|---|---|
| Deployed service URL | `README.md:15`, `skills/vaultradar/SKILL.md:10` |
| Deployed dashboard URL | `README.md:12`, `README.md:16`, `scripts/demo.sh:143` |
| substreams.dev package URL | `README.md:10`, `README.md:72`, `README.md:207`, `substreams/erc4626-vault-metrics/README.md:223` |
| HashScan tx URL, settled Hedera scan | `README.md:11`, `README.md:42`, `README.md:209` |
| Arcscan tx URL, settled Arc payment | `README.md:12`, `README.md:53`, `README.md:210` |
| Demo video URL | `README.md:17` |
| Messari live/total count from the verify gate | `README.md:68` |
| HCS topic id | `README.md:107`, `scripts/demo.sh:35` |
| HCS mirror-node URL | `README.md:108` |
| ERC-8004 agent id, Hedera testnet | `README.md:112` |
| ERC-8004 agent id, Arc testnet | `README.md:112` |
| Two live vault ids for the demo | `scripts/demo.sh:25` |
| Receipt hash printed by `agent watch` | `scripts/demo.sh:32` |

`grep -rn "<<FILL:" --include="*.md" --include="*.sh" .` reproduces the list.
`.env.example` deliberately has none: an env template's convention is a blank value.

## Verification performed

- `bash -n scripts/demo.sh` passes; file committed mode 100755.
- Booted the service on a spare port from the primary checkout and ran `demo.sh` against it
  end to end. Exit 0. Step 1's `jq` filter over the real agent card returns every field it
  names. Step 2 reports HTTP 404 there because that checkout has no Hedera rail mounted,
  and the script now says so explicitly instead of printing an empty decode.
- The 402 header decode is portable. My first version used `awk`'s `IGNORECASE`, which is
  a gawk extension and silently produced nothing on macOS. Replaced with
  `tolower($1) == "payment-required:"` in both `demo.sh` and `SKILL.md`, and tested both
  against a synthetic header. `base64` decoding tries `--decode` then falls back to `-D`,
  buffering stdin first so the retry has input.
- Regenerated both diagram PNGs and visually confirmed the harness block is gone.
- Confirmed `/skill.md`'s path resolution reaches the new `SKILL.md`.
- Confirmed no env name was dropped from `.env.example`.
- No em-dash in any of the four prose deliverables.

## Concerns

1. **The README references files that are not on this branch.** `packages/agent/`,
   `packages/service/src/rails/hedera.ts` and `packages/service/scripts/hello-arc.ts` live
   on `ws/agent`, `ws/service`, or nowhere yet. Every path in the README is correct for the
   merged tree, not for `ws/docs` today. Nothing to fix here, but do not read a broken link
   on this branch as an error.
2. **The prize table and scope notes will need a second pass after Tasks 17 to 23 land.**
   The Arc rail, HCS queue, ERC-8004 script, deployment and agent CLI are all described in
   future tense right now. When they merge, the "In flight at the time of writing" bullet
   and the Arc rail's "not yet mounted" sentence must both shrink, and the Arc row of the
   track table drops its "(in progress)" parenthetical.
3. **The Messari registry has `deploymentId: null` on all 15 rows.** Until
   `bun run verify-deployments` runs against a real Studio key, `gatewayUrl` falls back to
   the subgraph ID, which is the weaker guarantee the pinning story exists to replace. The
   README and `standards-leverage.md` both say to run the gate before a demo, and the live
   count is a marker. If the gate finds fewer than three live deployments, spec §5.1 says
   success criterion 3 is amended in the README, which would mean editing the section 4
   table.
4. **`packages/dashboard/README.md` is still stock `create-next-app` boilerplate.** I did
   not touch it; it was not in scope. It is the one file in the repo that reads as
   unfinished to a judge who opens it.
5. **The Arc mainnet path is documented as a config change and has not been executed.**
   `arc.network` is a literal union type `"eip155:5042002"` in `config.ts`, so switching to
   mainnet is a one-line type change plus a facilitator URL, not a pure env swap. The
   README says to change the file, which is accurate, but it is not zero-code.

## Files changed

Created:
- `README.md`
- `skills/vaultradar/SKILL.md`
- `scripts/demo.sh` (mode 755)
- `docs/standards-leverage.md`

Modified:
- `.env.example`
- `docs/architecture.md`
- `docs/architecture.png`, `docs/payment-flow.png` (regenerated)
- `substreams/erc4626-vault-metrics/README.md`
