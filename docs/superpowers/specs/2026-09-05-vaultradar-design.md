# VaultRadar — design spec

Date: 2026-09-05 (revised after independent review the same day). Event: ETHOnline 2026 (ETHGlobal), Start Fresh pool. Submission deadline: Sunday 2026-09-13, 12:00 EDT. Solo builder plus Claude Code.

## 1. One-line pitch

VaultRadar is a machine-payable, cross-protocol vault-risk service: one standardized query across every Messari-schema protocol plus a new ERC-4626 Substreams module, sold per request over x402 on Hedera and Arc, consumed by a risk-monitor agent. Requests and responses are sealed with post-quantum KEM so no intermediary learns the portfolio, a privacy tier lets the vendor learn only the protocol, and every receipt and data attestation is signed with ML-DSA-65 so it stays verifiable long after ECDSA is gone.

## 2. Prize targets and what each judge must see

Three partner picks (ETHGlobal caps a submission at three partners; all of a partner's tracks count as one pick).

| Partner / track | Must-show |
|---|---|
| The Graph — Composable / Standardized | One query template executed across N Messari deployments (yield-aggregator and lending schemas), pinned by deployment ID. A new ERC-4626 Substreams module composed from the Pinax `erc4626` package, running on two chains through The Graph Market. README section "what the standards made easier". |
| The Graph — AI Use Case (From Scratch) | Agent reasons over live Graph data and makes decisions; independently refuses stale data. x402 pay-per-query (agent pays service; optional: service pays The Graph gateway via x402 on Base). One-prompt Substreams generation using the Substreams Skills, recorded honestly (see 5.2). |
| Hedera — AI & Agentic Payments | Live x402-gated service on Hedera testnet settled through Blocky402. At least one real paid request end to end in the video. Extras: metered per-call pricing, HTS USDC settlement, ERC-8004 identity with the PQ key anchored on-chain, UCP discovery profile, HCS audit trail of commitments. |
| Hedera — Improve the Harness | Open PR to `hedera-dev/hedera-harness` adding a Tier 3.5 `x402Probe` chain validator, branched from open PR #15 (ephemeral-signer HTS association). Tests, docs section, before/after evidence, 15-second clip inside the main video. |
| Arc — Agentic Economy | Agent built on Circle's Claude Agent SDK starter kit, pays via Gateway nanopayments on Arc testnet, decision logic tied to real signals (price, balances, attestation age, privacy policy). Working frontend showing a live Arc payment, plus architecture diagram. |
| Arc — Launch and Push to Mainnet | Same integration with a documented mainnet config path ready by 2026-09-30 (Arc mainnet opens 2026-09-16). |

Finalist criteria (Technicality, Originality, Practicality, Usability, WOW): the sealed-channel and PQ-receipt layer is the WOW; the standards leverage is the practicality.

## 3. Threat model for the privacy and PQ layer

1. **Portfolio disclosure to intermediaries.** The vault list in a request, and the vault list plus verdicts in a response, pass TLS terminators, hosting proxies, logs, and traffic recorders positioned for harvest-now-decrypt-later. Mitigation: both request and response are sealed with a hybrid post-quantum KEM (section 5.4). The vendor itself does decrypt `scan` requests; only the `table` tier hides holdings from the vendor.
2. **Replay of a captured envelope.** A third party replays a sealed request with its own payment to obtain the plaintext answer. Mitigation: the response is sealed to a client ephemeral key inside the envelope, the envelope binds the paying account, and the service rejects envelopes outside a 120-second window or with a seen nonce.
3. **Unverifiable receipts.** ECDSA receipts cannot promise long-horizon verifiability to an auditor. Mitigation: ML-DSA-65 signatures over every receipt and attestation.
4. **Audit trail that leaks.** A public HCS log of queries would leak customer interests. Mitigation: HCS stores commitments (hashes plus signatures), never content.
5. **Key substitution during discovery.** A fake agent card could present a fake PQ key, and a registration file served from the same host cannot rule that out. Mitigation: the ML-DSA public-key hash is written on-chain as ERC-8004 metadata under the service's agent id; discovery reads it from the chain.

README boundary statement, verbatim: "The ML-DSA key is anchored on-chain by an ECDSA-controlled account. A verifier that has fetched and pinned the key once can verify receipts indefinitely without trusting ECDSA again. The anchor protects discovery today; it does not stop a future quantum adversary from re-pointing the registry. x402 payment signatures and chain consensus remain classical. There is no forward secrecy against later compromise of the service's KEM seed."

## 4. Architecture

```
                 ┌─────────────────────── The Graph ───────────────────────┐
                 │  Messari standardized subgraphs   The Graph Market      │
                 │  (yield 1.3.1, lending 3.1.0)     Substreams endpoint   │
                 └──────────┬──────────────────────────────┬───────────────┘
                            │ GraphQL by deployment ID     │ erc4626-vault-metrics.spkg
                            │ (Studio key / x402)          │ hosted sink → Postgres (Neon)
                            ▼                              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ packages/service  (Express)                                                │
│  standardized query layer → unify → freshness → risk                       │
│  POST /hedera/v1/*  x402 via @x402/express + Blocky402 (HTS USDC / HBAR)   │
│  POST /arc/v1/*     x402 via @circle-fin/x402-batching (Gateway, USDC)     │
│  PQ: seal/open (ML-KEM-768+X25519), ML-DSA-65 receipts, attestations, card │
│  HCS commitments · ERC-8004 identity + on-chain pq metadata · well-known   │
└───────────────┬───────────────────────────────────────────┬───────────────┘
                │ 402 → pay → 200 + sealed body + receipt   │ /v1/receipts (public commitments)
                ▼                                           ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ packages/agent (Claude Agent │              │ packages/dashboard (Next.js) │
│ SDK, Circle starter kit)     │              │ catalog · freshness · runs   │
│ discover → quote → choose    │              │ payments per rail · HCS      │
│ rail+tier → seal → pay →     │              │ receipt verifier             │
│ open → verify → decide       │              └──────────────────────────────┘
└──────────────────────────────┘
```

Monorepo (bun workspaces for TypeScript; Cargo for the Substreams module):

```
vaultradar/
  LICENSE                             MIT
  .env.example                        every variable, documented
  substreams/erc4626-vault-metrics/   Rust Substreams package
  packages/core/                      schema types, query templates, unify, freshness, risk, pq, receipts
  packages/service/                   x402-gated API, identity, HCS
  packages/agent/                     Claude Agent SDK agent
  packages/dashboard/                 Next.js UI
  skills/vaultradar/SKILL.md          how an agent uses the service (installable as a Claude Code skill)
  scripts/                            verify-deployments, identity bootstrap, demo
  docs/                               spec, architecture.md (mermaid), one-prompt.md
```

## 5. Components

### 5.1 Standardized data layer (`packages/core/standardized`)

- **Deployment registry** `deployments.json`: curated Messari deployments with `{ protocol, chain, schema: "yield-aggregator" | "lending", subgraphId, deploymentId, status, headLagSeconds, verifiedAt }`. Queries always use the pinned `deploymentId` via `https://gateway.thegraph.com/api/deployments/id/<Qm…>` so a subgraph re-point cannot silently change the data. Initial candidates: Aave v3 (Ethereum, Base), Compound v3 (Ethereum), Spark (Ethereum), Morpho-Aave v3 (Ethereum), Euler (Ethereum), Yearn v2 (Ethereum, Arbitrum), Convex, Aura, Arrakis, Gamma.
- **Verification gate** (`scripts/verify-deployments.ts`, run on Sept 5 and before every demo): queries `_meta { block { number timestamp } hasIndexingErrors }` on each and writes `headLagSeconds` and `status`: `live` when lag is at most 60 minutes, `stale` when larger, `down` when the query fails or reports indexing errors. Stale and down deployments stay in the registry on purpose; the stale-refusal demo uses them. If fewer than three deployments are `live` on Sept 5, the Composable story rests on the Substreams pipeline on two chains plus the standardized query across whatever is live, and success criterion 3 is amended accordingly in the README.
- **Query templates**, one per schema family, parameterized only by pagination: `yield.vaults` (Vault, last 24 VaultHourlySnapshot, last 8 VaultDailySnapshot) and `lending.markets` (Market, last 24 MarketHourlySnapshot, last 8 MarketDailySnapshot). Both include `_meta`. Exact field names are confirmed by schema introspection in the first implementation task; required fields are share price or exchange rate, TVL USD, input and output token, input token balance, output token supply, deposit limit (yield only), daily deposit and withdraw USD (lending), snapshot timestamps and block numbers.
- **Gateway client**: bearer Studio API key. Optional mode `UPSTREAM_X402=1` uses `@graphprotocol/client-x402` against the gateway's x402 endpoints, paying USDC on Base ($0.01 per query); used only for the "no API keys anywhere" demo segment.

### 5.2 ERC-4626 Substreams module (`substreams/erc4626-vault-metrics`)

- Rust package importing Pinax `erc4626` as a dependency (its `map_events` decodes `Deposit` and `Withdraw` for every ERC-4626 vault by topic, no address list).
- `initialBlock` per chain set to about 28 days before head at deploy time (Ethereum: head minus 200k blocks; Base: head minus 1.2M blocks) so backfill fits the Market free tier and finishes in hours.
- Modules:
  - `map_vault_events`: consumes Pinax events; emits `VaultEvent { vault, block, timestamp, kind, sender, owner, assets, shares, implied_share_price }` with `implied_share_price = assets / shares` as a decimal string.
  - `store_vault_meta` (set-if-not-exists, keyed by vault): on first sight of a vault, `eth_call` `asset()`, then `decimals()` and `symbol()` on the asset, and `decimals()` on the vault; stores `{ asset, asset_symbol, asset_decimals, share_decimals }`.
  - `store_depositor_seen` (set-if-not-exists, keyed `vault:owner`) and `map_new_depositors` (reads that store's deltas, emits one record per CREATE) feeding `store_depositor_count` (add, keyed by vault). Two chained stores because a store module cannot read its own deltas.
  - `store_vault_flows` (add, keyed by vault): cumulative assets deposited, assets withdrawn, shares minted, shares burned; plus `store_last_call_block` (set, keyed by vault).
  - `map_vault_metrics`: for vaults touched in the block, emits `VaultMetrics { chain_id, vault, block, timestamp, share_price, share_price_source: "event" | "call", total_assets, total_supply, net_deposited_assets, net_flow_assets, depositor_count, last_event_block }`. When a vault is touched and `block − last_call_block ≥ 300`, an `eth_call` batch to `totalAssets()` and `totalSupply()` refreshes exact `share_price = totalAssets / totalSupply` (decimals-aware) and updates the store; otherwise `total_assets` and `total_supply` are null and `share_price` is event-implied. `net_deposited_assets` is cumulative deposits minus withdrawals and is never presented as TVL.
  - `db_out`: `DatabaseChanges` for `substreams-sink-sql` with `schema.sql` defining `vault_metrics` (primary key `chain_id, vault, block`), `vault_latest` (primary key `chain_id, vault`), and `vault_meta`.
- Deployment: The Graph Market hosted sink to a Neon Postgres for Ethereum mainnet and Base. Fallback: `substreams-sink-sql` run on the service host against the same Market endpoint. Package published to substreams.dev as `erc4626-vault-metrics` by Sept 7, because the hosted sink may require a published package.
- Sink freshness comes from the sink's cursor block (stored in the sink's cursor table), not from a vault's `last_event_block`, so quiet vaults are not misreported as stale.
- One-prompt demo, recorded honestly: the first generation from a single prompt (events plus SQL sink) is recorded as the one-prompt run and committed as-is; the stores, eth_calls and review fixes follow in later commits. `docs/one-prompt.md` keeps the prompt, the generated diff, and the follow-up diff. The README never claims the final module is one prompt.

### 5.3 Unified view, freshness, risk (`packages/core`)

- `UnifiedVault { id: "<chainId>:<address>", kind: "yield-vault" | "lending-market" | "erc4626", protocol, chain, asset: { symbol, decimals } | null, sharePrice, tvlUsd: string | null, history: [{ block, timestamp, sharePrice, tvlUsd | null, netFlowAssets | null }], sources: [{ kind: "messari" | "substreams", ref, block, timestamp, ageSeconds }], freshness: "fresh" | "stale" | "unavailable" }`. All numerics are decimal strings.
- Freshness: `fresh` if the source's reference block is at most 60 minutes behind chain head for Messari and 5 minutes for Substreams; `stale` otherwise; `unavailable` if the query failed or `_meta.hasIndexingErrors` is true. The Messari reference block is `_meta.block`; the Substreams reference block is the sink cursor. Chain head comes from the JSON-RPC provider per chain, cached 15 seconds; RPC failure marks every source on that chain `stale`.
- Risk flags and per-schema definitions:
  - `share_price_drawdown_1h`, `_24h`, `_7d`: relative drop in share price (yield `pricePerShare`, lending `exchangeRate`, erc4626 `share_price`) over the window, thresholds 0.5 %, 2 %, 5 %. The 1 h flag requires hourly data (hourly snapshots or Substreams history); without it the flag is skipped, not guessed.
  - `tvl_outflow_24h`: yield uses the 24 h change in `inputTokenBalance` relative to the current balance; lending uses `dailyWithdrawUSD − dailyDepositUSD` relative to `totalDepositBalanceUSD`; erc4626 uses `net_flow_assets` over 24 h relative to `total_assets` (skipped when `total_assets` is null). Threshold 20 %.
  - `deposit_limit_reached`: yield only, `inputTokenBalance ≥ depositLimit` when a limit is set.
  - `stale_data`: any source not `fresh`.
- Score: drawdown 1 h 30, 24 h 25, 7 d 20; outflow 25; deposit limit 10; sum capped at 100. Verdict: `ok` below 20, `watch` 20–49, `alert` 50 and above. Hard rule: if any source needed for a flag is `stale` or `unavailable`, the verdict is `unavailable` and evidence names the source and its age. No verdict is ever inferred from partial data.
- `RiskReport { vaultId, flags: [{ name, value, threshold, window }], score, verdict, evidence: [{ source, block, timestamp, ageSeconds }] }`.

### 5.4 PQ, sealing, and receipt layer (`packages/core/pq`)

- Library: `@noble/post-quantum` 0.7.x only (public library; no code from prior projects).
- Keys: derived at boot from secrets `PQ_SIG_SEED` (32 bytes hex) and `PQ_KEM_SEED` (64 bytes hex) using the library's seeded key generation. No key material touches disk, so redeploys on Fly or Railway keep the same keys. Public keys and their SHA-256 hashes are published; `kid = SHA-256(kem_pk)[0..8]` identifies the KEM key in envelopes. KEM rotation is out of scope.
- Signatures: ML-DSA-65 (FIPS 204), signature about 3.3 KB, public key about 2 KB. Signatures always travel in JSON bodies, never headers.
- Sealing: hybrid KEM `ml_kem768_x25519` as exported by the library (the X-Wing style combiner), named `"ml-kem768-x25519"` in envelopes. Shared secret → HKDF-SHA-256 with info `"vaultradar/seal/v1"` → AES-256-GCM.
- Request envelope: `{ v: 1, kem: "ml-kem768-x25519", kid, ct, nonce, body }` where `body` encrypts canonical JSON of `{ request, reply_pk, payer, ts, req_nonce }`. `reply_pk` is a client ephemeral KEM public key; `payer` is the paying account (Hedera account id or Arc address); `ts` is a Unix timestamp; `req_nonce` is 16 random bytes. The clear header `X-VR-Count` carries the vault count for pricing.
- Response envelope: `{ sealed: { kem, ct, nonce, body }, receipt }` where `body` encrypts canonical JSON of `{ vaults, reports, attestations }` to `reply_pk`. In clear mode (no sealing), the response is `{ vaults, reports, attestations, receipt }` and the receipt records `sealed: false`.
- Service checks before answering: `ts` within 120 seconds of server time, `req_nonce` not seen in the last 10 minutes, `payer` equals the payer in the verified payment payload the x402 middleware attaches to the request, and `X-VR-Count` equals `request.vaults.length`. Any failure returns 422 before settlement, so nothing is charged.
- Canonical JSON: deterministic key ordering, no whitespace, all numerics as strings (avoids RFC 8785 float rules); a small internal canonicalizer. Hashes are SHA-256 over canonical bytes.
- Receipt (signed): `{ v: 1, service: { erc8004: [{ chainId, agentId }] }, request_hash, response_hash, sealed, sources: [{ ref, chainId, block, timestamp }], price: { amount, asset, rail }, payment: { rail: "hedera" | "arc", txId }, tier: "scan" | "table", issued_at, nonce, hcs: { topicId } }` plus `sig: { alg, pub_hash, value }`. `request_hash` is SHA-256 of the canonical plaintext `request`, so the agent can recompute it; `response_hash` is SHA-256 of canonical `{ vaults, reports, attestations }`; `receipt_hash` is SHA-256 of the canonical receipt without `sig`. The HCS sequence number is not in the signed receipt; it is looked up by `receipt_hash`.
- Attestation (one per vault in a response): `{ v: 1, vaultId, chainId, block, timestamp, sharePrice, tvlUsd, source }` plus `sig`. Individually signed, so it stays portable after the sealed response is opened.
- Verification tool: `bun run verify <receipt.json> [response.json]` and an agent tool; both check the signature, the `pub_hash` against the on-chain ERC-8004 metadata, and recompute `response_hash` when the response body is present.

### 5.5 Service (`packages/service`)

- Express on bun, Node 22 compatible. `express.json()` runs before every payment middleware so the x402 v2 request adapter's `getBody()` can validate envelopes in the price function.
- Public unpaid routes (CORS `*` on these only): `GET /.well-known/agent.json` (agent card with endpoints, prices, rails, PQ public keys and hashes, ERC-8004 ids, UAID when present; `sig` inside the JSON body), `GET /.well-known/ucp` (UCP profile listing services and two x402 payment handlers), `GET /.well-known/erc8004.json` (registration file), `GET /v1/catalog`, `GET /v1/receipts/:hash` returning `{ receipt_hash, topicId, sequence | null, consensus_timestamp | null, initial_transaction_id | null }`.
- Paid routes are registered by full path (`"POST /hedera/v1/scan"`, `"POST /arc/v1/scan/s"`, …) because the x402 adapter matches on the request path; handlers are shared functions.
  - Hedera `POST /hedera/v1/scan`: price `$0.001 + $0.0005 × count` from the x402 v2 per-request price function reading `X-VR-Count`; the function also validates envelope structure. Asset HTS USDC `0.0.429274`. A `POST /hedera/v1/scan-hbar` variant prices in tinybars for the harness validator.
  - Arc `POST /arc/v1/scan/s|m|l` for counts 1–5, 6–20, 21–100 at `$0.003`, `$0.01`, `$0.05`, because Circle's middleware is static per route.
  - `POST /{hedera,arc}/v1/table`: body `{ protocol, chainId }` (sealed or clear), flat `$0.06` on both rails, a deliberate privacy premium so `table` is never cheaper than a sealed `scan`. Returns every vault of that protocol. (Amended 2026-09-10: the original `$0.03` was below the `$0.051` a metered scan of the maximum 100 vaults costs, inverting the premium above 58 vaults; `$0.06` restores the stated invariant at every count.)
- x402 v2 order of operations: the middleware verifies the payment before the handler and settles only after a 2xx. Consequence: 4xx from the handler costs the payer nothing, and the signed Hedera transfer's validity window bounds handler time, so upstream work is capped at 60 seconds and returns 504 (unsettled) beyond that.
- Hedera rail: `@x402/express`, `@x402/core`, `@x402/hedera` pinned to one 2.x version; facilitator `https://api.testnet.blocky402.com`. Arc rail: `@circle-fin/x402-batching` `createGatewayMiddleware` against Circle's testnet Gateway facilitator, network `eip155:5042002`.
- After settlement: enqueue an HCS message `{ receipt_hash, sig, issued_at }` (about 4.6 KB, five chunks) to the service topic via `TopicMessageSubmitTransaction`, retry with backoff; the mirror node's `chunk_info.initial_transaction_id` reassembles chunks. The receipt lookup reports the sequence when confirmed.
- Identity bootstrap `scripts/identity.ts`: create the HCS topic; register in the ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e` on Hedera testnet (chain 296, via Hashio with an ECDSA-alias account and explicit gas limit) and Arc testnet (chain 5042002, gas paid in native USDC) with `agentURI` pointing at `/.well-known/erc8004.json` and metadata `pq.sig.pubhash = <hex>` set in the same flow; compute an HCS-14 UAID with `@hashgraphonline/standards-sdk` if time allows; write ids to `service.config.json`.
- Logging never includes decrypted bodies. Rate limit 60 requests per minute per IP on paid routes.
- Hosting: Fly.io or Railway with a stable public URL; all secrets via environment variables documented in `.env.example`.

### 5.6 Agent (`packages/agent`)

- Derived from `circlefin/agent-stack-starter-kits` Claude Agent SDK variant (public starter kit). Model: latest Claude via the Anthropic API.
- Wallets: Hedera testnet ECDSA account (`@x402/fetch` + `@x402/hedera` signer) and Arc testnet key with a Gateway deposit (`GatewayClient`); the Circle CLI handles Arc wallet setup and balance checks.
- Tools: `discover(url)` (fetch the card, verify its ML-DSA signature, read `pq.sig.pubhash` from ERC-8004 metadata on Hedera and Arc RPC, compare), `quote(request)` (unpaid 402 probe per rail), `pay_and_scan(request, policy)` (choose rail by `rail_preference` and balances, choose tier by `privacy`, seal with a fresh `reply_pk`, pay, open the response, verify the receipt and attestations, persist to `runs/<id>.json`), `verify_receipt`, `explain`. (Amended 2026-09-10: `quote` is local arithmetic over the pricing constants shared with the service, not a 402 probe — it makes no request. The probe's purpose was to learn what the service would actually demand, and that is instead enforced at the moment it is demanded: the per-rail ceilings refuse a 402 more than one percent over the quote before anything is signed, and `checkSettledPrice` holds the receipt's stated price to the same band afterwards. A probe would also be a second round trip whose answer the real 402 could contradict anyway.)
- Policy file `policy.json`: `{ budget: { hbar, usdc_hedera, usdc_arc }, privacy: "strict" | "balanced" | "cheap", rail_preference: "cheapest" | "hedera" | "arc", max_age_seconds }`. `strict` always buys `table`; `balanced` seals `scan`; `cheap` allows clear `scan`.
- Independent freshness: the agent rejects any attestation whose `timestamp` is older than `max_age_seconds` by its own clock, regardless of the service's `freshness` field, and records the rejection as `insufficient data`.
- Behavior: given a watchlist or wallet, budget the session, buy data, reason over `RiskReport`s, and output a decision per vault (`hold`, `withdraw`, `rebalance`, `insufficient data`) with citations: block numbers, deployment or package refs, payment tx ids, receipt hash, HCS sequence. Any `unavailable` verdict or rejected attestation yields `insufficient data`, never a guess.
- Interfaces: CLI (`bun run agent watch --vaults … --policy policy.json`) and an interactive chat mode. Optional tool: the official Subgraph MCP for ad-hoc deployment discovery.

### 5.7 Dashboard (`packages/dashboard`)

Next.js app. Data sources: the service's public endpoints (catalog, receipts) fetched live, and agent runs from `runs/<id>.json` served by a route handler when run locally; for the hosted demo a sanitized run is committed as `public/demo-run.json`. Pages: catalog and freshness per source, runs with verdicts and evidence, payments per rail with HashScan and Arcscan links (must show a live Arc payment from `/v1/receipts`), HCS commitments, and a receipt verifier. No auth. Satisfies Arc's "working frontend".

### 5.8 Hedera Harness PR

Fork `hedera-dev/hedera-harness`, branch from open PR #15 (rebase when it merges). Add a Tier 3.5 `x402Probe` chain validator: given a URL, assert an x402 v2 `PAYMENT-REQUIRED` for `hedera:testnet`, pay with the ephemeral signer through Blocky402 (HBAR route), and confirm settlement on the mirror node. Include tests, a section in `docs/authoring-a-recipe.md`, and before/after evidence: a recipe whose x402 endpoint could not be validated before passes with the validator. Opened before submission; linked from the README with a 15-second segment in the main video.

## 6. Data flow for one paid request (Hedera rail)

1. Agent calls `discover`; verifies the card's ML-DSA signature and the key binding against on-chain ERC-8004 metadata.
2. Agent builds the request, generates `reply_pk`, seals `{ request, reply_pk, payer, ts, req_nonce }`, POSTs to `/hedera/v1/scan` with `X-VR-Count`.
3. Middleware's price function validates envelope structure and returns 402 with `PAYMENT-REQUIRED` (exact scheme, `hedera:testnet`, HTS USDC, computed amount).
4. Agent signs a Hedera `TransferTransaction` whose transaction id names the Blocky402 fee payer and retries with `PAYMENT-SIGNATURE`.
5. Middleware calls Blocky402 `/verify`; on success the handler runs.
6. Handler opens the envelope, checks `ts`, `req_nonce`, `payer` and count, runs standardized queries and the Postgres read (60-second cap), unifies, computes freshness and risk, signs attestations, seals `{ vaults, reports, attestations }` to `reply_pk`, signs the receipt, and responds 200.
7. Middleware settles via Blocky402 `/settle` and adds `PAYMENT-RESPONSE` with the tx id.
8. Service enqueues the HCS commitment; agent opens the response, verifies receipt and attestations, applies its own age check, reasons, and prints the decision.

The Arc path differs in steps 3 to 7: Gateway middleware, EIP-3009 authorization, batched settlement.

## 7. Error handling

- Upstream subgraph error, timeout, or indexing errors: source `unavailable`; dependent verdicts `unavailable`; the receipt lists the failed source.
- Sink cursor more than 5 minutes behind head: Substreams source `stale`; same rule.
  **Amended 2026-09-12: the figure is 20 minutes, not 5.** The sink indexes finalized
  blocks only, so the newest block it can ever write trails the head by Ethereum's finality
  lag — 64 to 95 blocks, 13 to 19 minutes. Five minutes was therefore unsatisfiable in
  practice: the sink ran correctly and every vault it backed still read `stale`, which the
  service reports as `unavailable` — "no data" for data that is final and right. Twenty
  minutes (raised to 30 after measuring the running sink at an 80-150 block band) clears the lag while still bounding staleness, and it stays below the
  agent's own default `max_age_seconds` of 900s for the common case.
- Envelope malformed at quote time: 400 before payment. Envelope fails `ts`, nonce, payer or count checks after verify: 422, no settlement, nothing charged.
- Handler exceeds 60 seconds: 504, no settlement.
- Payment verify or settle failure: standard x402 4xx; agent retries once on transient errors, then reports.
- HCS submit failure: retried with backoff; responses never block on HCS; `sequence` stays null until confirmed.
- Chain head RPC failure: every source on that chain `stale`.

## 8. Testing

- Unit (bun test): canonical JSON, seeded key derivation determinism, sign/verify and seal/open round trips for request and response, replay rejection (old `ts`, reused nonce, payer mismatch, count mismatch), freshness thresholds, risk rules including "unavailable on partial data", price function, receipt and response hash recomputation.
- Substreams: `substreams run` over a fixed block range with a snapshot of expected `VaultMetrics` for two known vaults, one with an eth_call refresh; `substreams gui` for manual checks.
- Integration (env-gated, live testnets): one paid sealed `scan` on Hedera, one on Arc, one `table`, receipt verification, HCS sequence confirmed via mirror node.
- End to end: `scripts/demo.sh` runs discover, quote, paid scan on each rail, verification, and prints the decision; used for the video.

## 9. Deliverables and success criteria

1. Real paid request on Hedera testnet via Blocky402, visible on HashScan, with an HCS commitment.
2. Real paid request on Arc testnet via Gateway, visible on Arcscan and in the dashboard.
3. A scan returning at least three Messari-covered protocols plus at least one ERC-4626 vault not covered by Messari, all from live sources with per-source block heights (amended per the Sept 5 verification gate if fewer than three Messari deployments are live).
4. `erc4626-vault-metrics` published on substreams.dev and running through The Graph Market on two chains.
5. Sealed request and sealed response round trip, ML-DSA-65 receipt verification, and on-chain key binding demonstrated.
6. Agent decision with citations, and a demonstrated refusal on a stale deployment using the agent's own age check.
7. Harness PR opened.
8. README with architecture diagram, payment flow, "what the standards made easier", the boundary statement, run instructions; `LICENSE` (MIT); `.env.example`; `SKILL.md`; 2–4 minute video with no AI voiceover; continuous commit history from 2026-09-04.

## 10. Schedule, day-one de-risking, cut order

Revised 2026-09-09: the build started four days late. The operative schedule and cut list are in `docs/superpowers/plans/2026-09-09-vaultradar.md` (Global Constraints and "Workstreams and order"); the harness PR, HCS-14 UAID and the Falcon option are cut, and the Arc rail has a go/no-go on 2026-09-10 evening. The table below is the original plan, kept for the record.

| Date | Focus |
|---|---|
| Sept 5 | Accounts, keys and funding (section 12); repo skeleton; verify-deployments gate; HTS-USDC paid request through Blocky402 including association; `substreams run` with one eth_call against the Market endpoint and a hosted-sink deploy of any spkg into Neon |
| Sept 6 | Arc hello-402 through Gateway; service data layer and unify ∥ Substreams events module (one-prompt run recorded) |
| Sept 7 | Substreams stores, eth_calls, sink, spkg publish ∥ Hedera rail, PQ seal/open, receipts |
| Sept 8 | Agent: discover, quote, pay, open, verify, policy ∥ dashboard skeleton ∥ Arc rail wired to shared handlers |
| Sept 9 | HCS commitments, ERC-8004 registration with metadata, UCP profile, `table` tier; harness PR in the evening |
| Sept 10 | Integration tests on live testnets, dashboard live data, SKILL.md, README draft |
| Sept 11 | Architecture diagram, docs, dry run of `demo.sh`, fixes |
| Sept 12 | Video, submission |

Day-one de-risk items, in order: the HTS-USDC paid request through Blocky402; a Substreams run with an eth_call plus a hosted-sink deploy into Neon; the count of live Messari deployments.

Cut order if behind: HCS-14 UAID and the Falcon option; then the harness PR; then dashboard extras beyond the Arc requirement; then the Arc rail, only if its hello-402 has not succeeded by Sept 7. Never cut: `table`, receipts, sealing.

## 11. Out of scope

On-chain PQ payment signatures; zero-knowledge proofs of risk computation; A2A negotiation; scheduled or streamed payments; ENS; KEM key rotation and forward secrecy; mainnet money beyond a few dollars of USDC on Base for the optional upstream x402 demo.

## 12. Account and funding prerequisites (Sept 5, builder)

1. Subgraph Studio API key.
2. Two Hedera testnet ECDSA accounts (service payTo and agent) from the portal faucet; both associate HTS USDC `0.0.429274`; agent account funded with testnet USDC from Circle's faucet (20 USDC per two hours).
3. Circle developer account and CLI login; Arc testnet USDC from Circle's faucet for the agent, deposited to Gateway; separate native Arc testnet USDC in the ERC-8004 deployer account for gas.
4. Hashio JSON-RPC access for the Hedera ECDSA-alias deployer, gas limit set explicitly (300k).
5. Neon Postgres database, publicly reachable, for the hosted sink.
6. substreams.dev login via GitHub for publishing; The Graph Market API key.
7. Anthropic API key for the agent; Fly.io or Railway account for hosting.

## 13. Dashboard user and admin views (added 2026-09-10)

Requested after the first dashboard landed. Two views are added to `packages/dashboard`, each with a promised scope and a labelled stretch. Promised items ship; stretch items ship only if they fit without touching the promised ones.

### 13.1 Admin view (`/admin`)

Promised: a service-operator screen backed by a new read-only endpoint `GET /v1/admin/metrics` on the service, gated by `Authorization: Bearer <ADMIN_TOKEN>` (401 otherwise). Response shape, all numerics as strings:

```
{ uptimeSeconds, startedAt,
  rails: { hedera: { enabled, facilitatorUrl, healthy, checkedAt }, arc: { enabled, facilitatorUrl, healthy, checkedAt } },
  hcs: { enabled, topicId, pending, submitted, failed, lastSequence },
  settlements: { hedera: { count, revenueAtomic, asset }, arc: { count, revenueUsd } },
  requests: { scan, table, rejected4xx, unavailableVerdicts, lastRequestAt },
  deployments: [{ protocol, chain, chainId, status, headLagSeconds, lastQueriedAt, lastError }],
  heads: { "<chainId>": { ts, block, ok, checkedAt } },
  keys: { sigPubHash, kemKid },
  identity: [{ chainId, agentId, onChainPubHash, matches }] }
```

Counters live in an in-process `Metrics` object fed by the handlers (requests, verdicts), both rails' `onSettled` hooks (settlements and revenue), the HCS queue (pending, submitted, failed, last sequence), the data provider (deployment query outcomes, heads), and the identity reader (on-chain hash match, refreshed every 10 minutes). Counters reset on restart; that is stated in the UI. Rail health probes hit each facilitator's supported-kinds endpoint, cached 30 seconds.

The dashboard page renders every field with status colours, refreshes every 15 seconds, and reads the token from the `ADMIN_TOKEN` server-side environment variable only.

Stretch: a settlements table with the last 50 receipt hashes and transaction links.

### 13.2 User view (`/portfolio`)

Promised: a portfolio owner's screen. The user pastes a vault list (`<chainId>:<address>` per line) and presses "Scan now". A dashboard API route runs the agent client server-side with the operator-funded agent account (`AGENT_HEDERA_ACCOUNT_ID` / `AGENT_HEDERA_KEY`, policy from `POLICY_PATH`), pays the x402 request for real, verifies the receipt, saves a run, and returns verdicts and decisions. The page shows verdicts, flags, decisions with citations, the payment transaction link, and the receipt hash, and lists history for the same vaults from previous runs. Purchases are rate-limited per client address (one paid scan per 30 seconds) and capped by the policy budget. If the agent keys are absent the page says so and offers the demo run.

Stretch, in order: (a) enter a wallet address and discover its ERC-4626 positions by `balanceOf` multicall over the service's free vault list (`GET /v1/vaults?chainId=`), (b) pay from a browser wallet on Arc via the Circle Gateway scheme if the SDK accepts an injected account, (c) the same via a Hedera wallet. None of the stretch items is claimed anywhere until it works end to end.

### 13.3 Boundary and honesty

The promised user flow is "buy a scan from the browser with a real x402 settlement"; the payer is the operator's agent account, and the README says so. Browser-wallet payment is described only if a stretch item ships.
