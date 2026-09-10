# What the standards made easier

A note for The Graph judges on what VaultRadar did not have to build, and why the composable pieces are load-bearing rather than decorative.

VaultRadar answers one question: is this vault behaving abnormally, as of which block. To answer it across protocols, you need share price history, deposit and withdrawal flows, and a trustworthy notion of how current the data is. Getting those three things for ten protocols is normally ten integrations. It was two query templates and one Substreams module.

## Before and after, on the query side

**Without standardized schemas.** Every protocol publishes its own subgraph with its own entity names, its own field for share price, and its own snapshot cadence. Yearn calls it one thing, Aave another, Euler a third. Adding the eleventh protocol means reading an eleventh schema, writing an eleventh query, and writing an eleventh mapper into the internal model. The work is linear in protocols and never stops.

**With Messari's standardized schemas.** There are two schema families, not ten. `packages/core/src/standardized/templates.ts` holds exactly two GraphQL queries, seventeen lines of source in total:

- `YIELD_VAULTS_QUERY` against yield-aggregator 1.3.1, reading `pricePerShare`, TVL, input token balance, deposit limit, and the last 24 hourly plus 8 daily snapshots.
- `LENDING_MARKETS_QUERY` against lending 3.1.0, reading `exchangeRate`, deposit and borrow balances, and the same snapshot windows.

Both are parameterized only by pagination. Neither knows the name of a single protocol.

| | Per-protocol integration | Standardized schema |
|---|---|---|
| GraphQL queries to write and maintain | one per protocol | two, one per schema family |
| Mappers into the internal model | one per protocol | two, in `map.ts` |
| Cost of adding a protocol | a new schema to read, a new query, a new mapper | one row in `deployments.json` |
| Field names to reconcile for share price | one per protocol | two, `pricePerShare` and `exchangeRate` |

Today those two templates cover 15 pinned deployments across 10 protocols and 5 chains: Aave v3, Compound v3, Spark, Morpho-Aave v3, Euler, Yearn v2, Convex, Aura, Arrakis, and Gamma. Adding Arrakis on a fourth chain was one JSON object. No code changed.

## Pinning by deployment ID, not by name

A risk verdict is a claim about a specific block. If the subgraph underneath a name can be re-pointed, the claim is unfalsifiable later.

So every query goes to `https://gateway.thegraph.com/api/deployments/id/<deploymentId>`, and the deployment ID is what lands in the signed receipt's `sources` array. A verifier holding a receipt from last week can query the same pinned deployment and check the numbers. That property comes directly from the gateway exposing deployment IDs as first-class addressable endpoints.

The registry ships with `deploymentId: null` on every row, because the ID is the deployment that answered, not something to guess in advance. `scripts/verify-deployments.ts` reads it back from `_meta { deployment }` and writes it into `deployments.json`. Until it has run, `gatewayUrl` falls back to the subgraph ID, which is exactly the weaker guarantee this pinning exists to replace. Run the gate before a demo.

The registry also carries `status` and `headLagSeconds`, written by `scripts/verify-deployments.ts` from each deployment's own `_meta { block { number timestamp } hasIndexingErrors }`. That one standardized field is what makes the refusal rule possible at all. Without a uniform way to ask a subgraph how far behind it is, "refuse when stale" would be guesswork per protocol.

## Before and after, on the Substreams side

Messari's schemas do not cover every ERC-4626 vault. Plenty of vaults have no subgraph at all. That gap is what `substreams/erc4626-vault-metrics/` fills.

**Without a composed package.** Tracking every ERC-4626 vault on a chain means either maintaining an address list, which is wrong the moment a new vault deploys, or writing a log scanner that matches the `Deposit` and `Withdraw` event signatures and decodes them correctly, per chain.

**With Pinax's `erc4626` package.** It already decodes both events for every ERC-4626 contract on the chain, matched by topic, with no address list. VaultRadar imports it as a dependency and does no log scanning of its own. `map_vault_events` is a thin transform over its output: normalize the fields, compute `implied_share_price` as assets over shares, tag each event with its vault.

Everything above that layer is the part worth building: stores for cumulative flows and distinct depositor counts, a staggered `eth_call` refresh that cross-checks event-implied share price against `totalAssets()` over `totalSupply()`, and a `db_out` module emitting `DatabaseChanges` for the SQL sink.

## One module, two chains

`db_out` takes `chain_id` as a Substreams runtime parameter rather than compiling it in. The consequence is concrete:

| | Per-chain module | Parameterized module |
|---|---|---|
| WASM binaries to build and publish | one per chain | one |
| Files that differ per chain | the module source | `network`, `initialBlock`, `params.db_out` in the manifest |
| Postgres databases | one per chain, or a schema per chain | one, because every primary key includes `chain_id` |

Ethereum mainnet runs from `substreams.yaml` with `db_out=1`. Base runs from `substreams.base.yaml` with `db_out=8453`. Same compiled code. Both sinks write to the same tables in the same database, and a query for one chain cannot accidentally read the other's rows.

## What the composability bought, in one line

The standardized schemas made the number of integrations independent of the number of protocols. The composed Substreams package made the number of chains independent of the number of modules. Together they are why a solo build could ship cross-protocol, cross-chain risk data in a week, and why the receipt attached to every answer can name the exact deployment and block it came from.
