# VaultRadar

VaultRadar is a machine-payable, cross-protocol vault-risk service. One standardized query template per schema family runs across every Messari-schema deployment in its registry, alongside a new ERC-4626 Substreams module composed from Pinax's `erc4626` package. Risk reports are sold per request over x402 on Hedera and on Arc, and consumed by a risk-monitor agent. Requests and responses are sealed with a hybrid post-quantum KEM, so no intermediary learns the portfolio. A privacy tier lets the vendor learn only the protocol. Every receipt and per-vault attestation is signed with ML-DSA-65, so it stays verifiable long after ECDSA is gone.

Built for ETHOnline 2026. Partner tracks targeted below.

| Track | What to look at |
|---|---|
| The Graph, Best Use of Composable or Standardized Graph Products | One template per schema family in `packages/core/src/standardized/templates.ts`, run across 15 pinned deployments in `packages/core/src/standardized/deployments.json`. The ERC-4626 module in `substreams/erc4626-vault-metrics/` imports Pinax `erc4626` and ships to two chains from one WASM binary. |
| The Graph, Best AI Tooling or AI Use Case (From Scratch) | The agent in `packages/agent/src/client.ts` discovers, seals, pays, opens and verifies before it reasons. It refuses stale data on its own clock, not on the service's word. Package: `<<FILL: substreams.dev package URL for erc4626-vault-metrics>>` |
| Hedera, AI & Agentic Payments on Hedera | The x402 rail in `packages/service/src/rails/hedera.ts` prices per vault and settles HTS USDC through Blocky402. A real settled request: `<<FILL: HashScan transaction URL for a settled Hedera scan>>` |
| Arc, Best Agentic Economy Application with Circle Agent Stack | Bucketed Arc routes on the agent card, the Circle Gateway rail, and the dashboard at <https://vaultradar-dashboard-production.up.railway.app> showing the same receipts and decisions. A real settled payment: the Gateway batcher's reference `cbc2021d-d57e-4e05-b43f-56707a532f33` for a 0.003 USDC scan whose receipt verified. On chain: the [ERC-8004 registration](https://testnet.arcscan.app/tx/0x0ebaa26fbf5c6db6f99eee116deccdef0aa766b7fad4d24bcb819e087b82ffc2) and the [Gateway deposit that funded the payment](https://testnet.arcscan.app/tx/0xe253e739cd2ca42c11c841db8d6891470ee0d22bff5ba30acb75c453ce35ac64). |
| Arc, Launch on Arc Testnet & Push to Mainnet | Arc testnet config lives in `packages/service/src/config.ts` under `arc`, network `eip155:5042002`. The mainnet path is a config swap, documented in the run section below. |

Live service: <https://vaultradar-service-production.up.railway.app>
Dashboard: <https://vaultradar-dashboard-production.up.railway.app>
Video: `<<FILL: 2-4 minute demo video URL>>`

## Architecture

![VaultRadar architecture](docs/architecture.png)

![One paid request on the Hedera rail](docs/payment-flow.png)

Both diagrams are mermaid source in [docs/architecture.md](docs/architecture.md). Regenerate the PNGs with `node scripts/render-diagrams.mjs`.

The shape is: The Graph supplies data two ways, the service turns it into signed risk reports behind an x402 paywall, and an agent buys it under a policy.

## Payment flow

### Hedera rail

1. The agent fetches `/.well-known/agent.json`, verifies the card's ML-DSA-65 signature, and compares `pq.sig.pub_hash` against the ERC-8004 registry's `getMetadata(agentId, "pq.sig.pubhash")` on chain 296.
2. The agent generates an ephemeral KEM keypair, seals `{ request, reply_pk, payer, ts, req_nonce }` to the service's KEM public key, and POSTs it to `/hedera/v1/scan` with the clear header `X-VR-Count`.
3. The price function reads `X-VR-Count`, validates the envelope's shape, and the middleware answers 402 with a `PAYMENT-REQUIRED` header. The amount is $0.001 plus $0.0005 per vault, in HTS USDC `0.0.429274` on `hedera:testnet`.
4. The agent checks the demanded amount against its own quote, and only then signs a Hedera `TransferTransaction` naming the Blocky402 facilitator as fee payer and retries the POST with a `PAYMENT-SIGNATURE` header. That quote is computed locally from the pricing table shared with the service rather than probed over the wire, so the check is what binds the two: a 402 demanding more than one percent over the quote is refused before anything is signed, on either rail, and the receipt's stated price is checked against the same band afterwards.
5. The middleware calls Blocky402 `/verify`. Only on success does the handler run.
6. The handler opens the envelope, checks `ts` against a 120 second window, checks `req_nonce` against the replay store, checks `payer` against the payer the facilitator verified, and checks `X-VR-Count` against the request's own vault count. It then runs the standardized queries and the Postgres read under a 60 second cap, unifies, computes freshness and risk, signs one attestation per vault, seals the body to `reply_pk`, signs the receipt, and answers 200.
7. The middleware settles via Blocky402 `/settle` and sets `PAYMENT-RESPONSE` with the transaction id.
8. The service enqueues an HCS commitment of the receipt hash. The agent opens the response, verifies the receipt and every attestation, applies its own age check, and decides.

A settled request: `<<FILL: HashScan transaction URL for a settled Hedera scan>>`

### Arc rail

Steps 1, 2, 6 and 8 are identical. Steps 3 to 7 differ:

- **Step 3.** Circle's Gateway middleware answers 402 on one of the bucketed routes, `/arc/v1/scan/s|m|l` for counts 1 to 5, 6 to 20, and 21 to 100. Circle's middleware is static per route, so the bucket carries the price rather than a price function.
- **Step 4.** The agent signs an EIP-3009 transfer authorization instead of a Hedera transaction.
- **Step 5.** The Gateway facilitator verifies the authorization.
- **Step 7.** Settlement is batched by Gateway. Unlike the Hedera rail, Circle's middleware verifies *and settles* before the request handler ever runs — the receipt records the authorization's transaction reference, but the money has already moved by the time the handler produces that receipt, not after.

Because settlement happens before the handler, every check that can reject a request outright — the `X-VR-Count`/bucket match, and (for a sealed request) the timestamp window, nonce replay, and vault-count-vs-header agreement — runs ahead of payment, in a pre-payment middleware. The one check that cannot run that early is whether a sealed request's claimed payer matches the payer Circle's Gateway actually settled with: that payer is only known once the payment has already gone through. **A `payer_mismatch` on the Arc rail is therefore detected after settlement and is not refunded** — a real limitation of Circle Gateway's settle-before-handler design, not a gap in this service's own validation.

A settled request. The rail has been exercised end to end against the deployed service: the agent deposited 2 USDC into Circle Gateway ([deposit](https://testnet.arcscan.app/tx/0xe253e739cd2ca42c11c841db8d6891470ee0d22bff5ba30acb75c453ce35ac64), after an [approval](https://testnet.arcscan.app/tx/0xcb3e84eb2c788e46cb5ae5110a7b50fc4d8f85d84b2ebd398c50a6d50e54c949)), then paid 0.003 USDC for a sealed scan. The batcher's reference for that payment is `cbc2021d-d57e-4e05-b43f-56707a532f33`; the receipt verified and the sealed reply opened. Circle settles batches asynchronously, so a Gateway payment's own reference is a batch id rather than an Arc transaction hash — the on-chain evidence for the rail is the funding deposit above, plus the registration that anchors the service's key.

## What the standards made easier

Full write-up for judges: [docs/standards-leverage.md](docs/standards-leverage.md).

**One template, many protocols.** `packages/core/src/standardized/templates.ts` holds exactly two GraphQL queries, one per Messari schema family. They are parameterized only by pagination. Those two queries cover 15 pinned deployments across 10 protocols and 5 chains, listed in `deployments.json`:

| Schema family | Protocols |
|---|---|
| lending 3.1.0 | aave-v3 (Ethereum, Base), compound-v3, spark, morpho-aave-v3, euler |
| yield-aggregator 1.3.1 | yearn-v2 (Ethereum, Arbitrum), convex-finance, aura-finance, arrakis-finance (Ethereum, Optimism, Polygon), gamma-strategies (Ethereum, Polygon) |

The verification gate has run: **11 of the 15 registrations are live**, 1 is stale, and 3 are down (convex-finance and aura-finance on Ethereum stopped indexing years ago, and aave-v3 on Base resolves to no allocations). Fourteen of the fifteen deployment ids are pinned in `deployments.json`; the fifteenth could not be pinned because there is nothing there to pin, and it resolves by subgraph id. Every query on a pinned deployment goes to that exact `deploymentId`, so a re-point cannot silently change the data underneath a risk verdict. A dead registration is not hidden: its sources never classify as fresh, so the vaults under it are reported `unavailable`.

**One module, two chains.** `substreams/erc4626-vault-metrics/` imports Pinax's public `erc4626` package as a dependency and never scans logs itself. `chain_id` is a Substreams runtime parameter, so the same compiled WASM runs on Ethereum mainnet and on Base. Only the manifest differs: `substreams.yaml` versus `substreams.base.yaml`. Both sinks write to one Postgres, because every table's primary key includes `chain_id`.

Published package: `<<FILL: substreams.dev package URL for erc4626-vault-metrics>>`

**The one-prompt challenge, honestly.** The one-prompt Substreams generation was not run. Installing the Substreams Skills plugin was out of scope for this build, so the module was written by hand. The exact prompt is recorded in [docs/one-prompt.md](docs/one-prompt.md) along with a finding that matters to anyone who tries it: the `substreams-sink-sql` protodefs release fails `substreams protogen` under CLI 1.22.0, so the SQL half of that prompt hits a wall regardless of wording. Nothing in this repo claims the module came from one prompt.

## Freshness and the refusal rule

A risk verdict is only as good as the block it was computed from, so freshness is a first-class field rather than a footnote.

| Source kind | Reference block | Fresh within |
|---|---|---|
| Messari subgraph | `_meta.block` | 60 minutes of chain head |
| Substreams sink | the sink's cursor block | 5 minutes of chain head |

Anything past the threshold is `stale`. A failed query, or `_meta.hasIndexingErrors`, is `unavailable`. Chain head comes from a per-chain JSON-RPC provider, cached 15 seconds. If that RPC call fails, every source on that chain is marked stale rather than assumed current.

The refusal rule has two independent halves.

The service refuses first. In `packages/core/src/risk.ts`, any vault whose sources are not all `fresh` gets a `stale_data` flag, a score of zero, and the verdict `unavailable`. No partial verdict is ever inferred from the data that did arrive. The evidence array still names the source, its block, and its age, so the refusal is auditable.

The agent refuses independently. It checks each attestation's `timestamp` against its own `max_age_seconds` policy value on its own clock, regardless of what the service said about freshness. A rejected attestation becomes `insufficient data`, never a guess.

## Privacy and post-quantum

**Sealed requests.** The request body is `{ v: 1, kem: "ml-kem768-x25519", kid, ct, nonce, body }`. The encrypted plaintext is `{ request, reply_pk, payer, ts, req_nonce }`. The hybrid KEM is ML-KEM-768 combined with X25519, from `@noble/post-quantum` 0.7.1. The shared secret goes through HKDF-SHA-256 with info `vaultradar/seal/v1` into AES-256-GCM. Only the vault count leaks, in the clear `X-VR-Count` header, because the price depends on it.

**Sealed responses.** The reply is sealed to the `reply_pk` the client generated for that one request. A third party who captures the envelope and pays for it again cannot read the answer, because they do not hold the reply secret.

**Replay defence.** The service rejects an envelope whose `ts` is more than 120 seconds from server time, whose `req_nonce` has been seen in the last 10 minutes, whose `payer` does not match the payer the payment layer verified, or whose count does not match. All four checks return 422 before settlement, so a rejected request costs nothing.

**Privacy tiers.** A clear `scan` hides nothing. A sealed `scan` hides the portfolio from every intermediary, but the vendor still decrypts it. The `table` tier hides holdings from the vendor too, by buying every vault of one protocol and filtering locally. `table` costs a flat $0.06 on both rails, which is deliberately never cheaper than a sealed scan: a scan of the maximum 100 vaults costs $0.051.

**Receipts and attestations.** Every response carries an ML-DSA-65 signed receipt binding `request_hash`, `response_hash`, the sources with their blocks, the price, the payment transaction id, the tier, and whether the exchange was sealed. Each vault also gets its own signed attestation, so a single vault's data stays portable and verifiable after the sealed response is opened and discarded.

**HCS commitments.** After settlement the service enqueues `{ v: 1, receipt_hash, sig, issued_at }` to a Hedera Consensus Service topic. Only the hash and the signature go on the public log, never the content, so the audit trail cannot leak what anyone asked about. Look a receipt up by hash at `/v1/receipts/:hash`, which returns the sequence number once consensus confirms it.

Topic: `0.0.10483981`
Mirror node: <https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10483981/messages>

**On-chain key anchor.** The service's ML-DSA public-key hash is written as ERC-8004 metadata under `pq.sig.pubhash`, at registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` on both testnets. Discovery reads it from the chain, so a forged agent card served from a compromised host still fails the check.

ERC-8004 agent ids: Hedera chain 296 `112` (registration tx `0x0f23d2a0c2c3a820e69e4304027f5d442c6ae4a8cff1147a6ea8b4e5bda9ca3a`); Arc chain 5042002 not registered — see the scope notes.

**The boundary, stated plainly.** Quoting the design spec:

> The ML-DSA key is anchored on-chain by an ECDSA-controlled account. A verifier that has fetched and pinned the key once can verify receipts indefinitely without trusting ECDSA again. The anchor protects discovery today; it does not stop a future quantum adversary from re-pointing the registry. x402 payment signatures and chain consensus remain classical. There is no forward secrecy against later compromise of the service's KEM seed.

## Run it

### Prerequisites

- Bun 1.3 or newer, and Node 22 for the diagram renderer.
- A Subgraph Studio API key.
- Two Hedera testnet ECDSA accounts, one for the service `payTo` and one for the agent. Both must associate HTS USDC `0.0.429274`. Fund the agent account with testnet USDC from Circle's faucet and with HBAR for its own signature.
- A Circle developer account, Arc testnet USDC deposited to Gateway for the agent, and separate native Arc testnet USDC for ERC-8004 registration gas.
- Hashio JSON-RPC access for the Hedera ECDSA-alias deployer, with the gas limit set explicitly.
- A publicly reachable Postgres for the Substreams sink. Neon works.
- A substreams.dev login and a The Graph Market API key, for publishing and for the Substreams endpoint.
- An Anthropic API key for the agent, and a host for the service. It runs on Railway today
  (`packages/service/Dockerfile`, `packages/dashboard/Dockerfile`, and
  `substreams/erc4626-vault-metrics/Dockerfile` for the sink); nothing in the code is specific to it.

### Setup

```bash
cp .env.example .env      # then fill it in; every variable is commented
bun install
bun test
```

### Service

```bash
bun run service           # or: bun run packages/service/src/main.ts
curl -s localhost:8787/.well-known/agent.json | jq '{endpoints, prices, pq}'
```

### Agent

```bash
bun run agent watch --vaults 1:0xVAULT_ADDRESS,8453:0xVAULT_ADDRESS --policy packages/agent/policy.example.json
```

The `watch` command and its policy file are built and covered by `bun test`: the loop lives in `packages/agent/src/watch.ts`, and two ready-made policies ship as `packages/agent/policy.example.json` (balanced, sealed scan) and `packages/agent/policy.strict.json` (strict, whole-protocol table). `scripts/demo.sh` drives both — step 3 runs `watch` under the balanced policy and step 4 runs it again under the strict one.

### Dashboard

```bash
cd packages/dashboard
SERVICE_URL=http://localhost:8787 NEXT_PUBLIC_SERVICE_URL=http://localhost:8787 bun run dev
```

Server components read `SERVICE_URL`. The in-browser receipt verifier at `/verify` needs the URL inlined at build time, so it reads `NEXT_PUBLIC_SERVICE_URL`. Set both.

### Substreams sink

Build and pack both manifests first, per `substreams/erc4626-vault-metrics/README.md`. Then set up the database once per chain, and run one sink per chain. The `--cursors-table` value matters: `packages/core/src/substreams/reader.ts` reads sink progress from `cursors_<chainId>`, so a shared default `cursors` table would let one chain's cursor answer for another.

```bash
export DATABASE_URL='postgres://USER:PASS@HOST/DB?sslmode=require'
export SUBSTREAMS_API_TOKEN='...'     # from thegraph.market

substreams-sink-sql setup "$DATABASE_URL" ./erc4626-vault-metrics-v0.1.0.spkg \
  --cursors-table cursors_1
substreams-sink-sql setup "$DATABASE_URL" ./erc4626-vault-metrics-base-v0.1.0.spkg \
  --cursors-table cursors_8453

substreams-sink-sql run "$DATABASE_URL" ./erc4626-vault-metrics-v0.1.0.spkg \
  -e mainnet.eth.streamingfast.io:443 --params db_out=1 \
  --cursors-table cursors_1 --final-blocks-only

substreams-sink-sql run "$DATABASE_URL" ./erc4626-vault-metrics-base-v0.1.0.spkg \
  -e base-mainnet.streamingfast.io:443 --params db_out=8453 \
  --cursors-table cursors_8453 --final-blocks-only
```

The `substreams` CLI 1.22.0 ships the same sink built in, if you would rather not install a second binary. It takes the connection string as a flag instead of a positional argument, and the same `--cursors-table`:

```bash
substreams sink postgres ./erc4626-vault-metrics-v0.1.0.spkg \
  --dsn "$DATABASE_URL" -e mainnet.eth.streamingfast.io:443 \
  --params db_out=1 --cursors-table cursors_1 --final-blocks-only
```

Check the deployment registry before a demo:

```bash
bun run verify-deployments
```

### Arc mainnet path

Arc mainnet is a config change, not a code change. Point `ARC_FACILITATOR_URL` at the mainnet Gateway facilitator and change `arc.network` in `packages/service/src/config.ts` from `eip155:5042002` to the Arc mainnet chain id. The seller address, the bucketed routes, and the shared handler are unchanged.

## Prize mapping and scope

| Track | Where it lives | Evidence |
|---|---|---|
| The Graph, Composable / Standardized | `packages/core/src/standardized/`, `substreams/erc4626-vault-metrics/` | Two templates over 15 deployments; one WASM module on two chains; `<<FILL: substreams.dev package URL for erc4626-vault-metrics>>` |
| The Graph, AI Use Case (From Scratch) | `packages/agent/`, `packages/core/src/risk.ts` | Independent age check and `insufficient data` refusal; per-request x402 payment |
| Hedera, AI & Agentic Payments | `packages/service/src/rails/hedera.ts`, `packages/service/src/keys.ts` | Metered pricing, HTS USDC via Blocky402, ERC-8004 identity with on-chain PQ key hash, UCP profile, HCS commitments; `<<FILL: HashScan transaction URL for a settled Hedera scan>>` |
| Arc, Agentic Economy | Arc rail and `packages/dashboard/` | Bucketed Gateway nanopayments and a live payment in the dashboard; `<<FILL: Arcscan transaction URL for a settled Arc payment>>` |
| Arc, Launch and Push to Mainnet | `packages/service/src/config.ts` | Documented mainnet config path, above |

Honest scope notes, so nothing here is read as more than it is:

- **The Hedera Harness PR was cut.** No PR to `hedera-dev/hedera-harness` was opened. The `POST /hedera/v1/scan-hbar` route that the proposed Tier 3.5 `x402Probe` validator would have exercised does exist and is mounted, but the validator itself does not.
- **HCS-14 UAID is not implemented.** The agent card has no `uaid` field. Identity is ERC-8004 plus the signed card, nothing more.
- **Falcon signatures are not implemented.** Signatures are ML-DSA-65 only. Falcon was considered as a smaller-signature option and dropped.
- **The upstream x402 payment to The Graph gateway was cut.** Standardized queries use a Studio API key. The service does not pay the gateway per query.
- **What is deployed, and what is not.** The service, the dashboard and the Substreams sink run on Railway, the sink is indexing, and the service is registered on chain on **both** chains: HCS topic `0.0.10483981`, ERC-8004 agent id `112` on Hedera (chain 296) and `894342` on Arc (chain 5042002). The agent's own discovery resolves both anchors, and `/v1/receipts/:hash` returns the HCS sequence for a committed receipt. The Arc rail has taken a real payment (see its section above). The Hedera rail has not: the agent's Hedera account holds no testnet USDC, which is a faucet visit, and the service's `payTo` account is not associated with the token either.
- **A paid request needs a funded payer account.** The identity rule still applies on top of that: a card with no ERC-8004 identity, or an identity whose registry read fails, is refused by both the agent and the dashboard before they pay.

- **KEM key rotation and forward secrecy are out of scope.** So are on-chain PQ payment signatures and zero-knowledge proofs of the risk computation.

## License

MIT. See [LICENSE](LICENSE).

Built with Claude Code: https://claude.ai/code/session_01GP7VEZFF8kYLm28Syzbar8
