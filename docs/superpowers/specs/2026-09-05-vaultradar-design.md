# VaultRadar — design spec

Date: 2026-09-05. Event: ETHOnline 2026 (ETHGlobal), Start Fresh pool. Submission deadline: Sunday 2026-09-13, 12:00 EDT. Solo builder plus Claude Code.

## 1. One-line pitch

VaultRadar is a machine-payable, cross-protocol vault-risk service: one standardized query across every Messari-schema protocol plus a new ERC-4626 Substreams module, sold per request over x402 on Hedera and Arc, consumed by a risk-monitor agent, with post-quantum-signed receipts and sealed (encrypted) requests so the vendor never learns the agent's portfolio.

## 2. Prize targets and what each judge must see

Three partner picks (ETHGlobal caps a submission at three partners; all of a partner's tracks count as one pick).

| Partner / track | Must-show |
|---|---|
| The Graph — Composable / Standardized | One query template executed across N Messari deployments (yield-aggregator and lending schemas). A new ERC-4626 Substreams module composed from the Pinax `erc4626` package, deployed on two chains via The Graph Market. Explicit "what became easier" section in README. |
| The Graph — AI Use Case (From Scratch) | Agent reasons over live Graph data and makes decisions; refuses to act on stale data. x402 pay-per-query (agent pays service; optional: service pays The Graph gateway via x402 on Base). One-prompt Substreams deployment using the Substreams Skills, recorded. |
| Hedera — AI & Agentic Payments | Live x402-gated service on Hedera testnet settled through Blocky402. At least one real paid request end to end in the video. Extras: metered per-call pricing, HTS USDC settlement, ERC-8004 identity plus HCS-14 UAID, UCP discovery profile, HCS audit trail. |
| Hedera — Improve the Harness | Open PR to `hedera-dev/hedera-harness`: fix ephemeral-signer HTS association (issue #15) and add an x402 probe-and-settle validation tier. Short clip linked from README. |
| Arc — Agentic Economy | Agent built on Circle's Claude Agent SDK starter kit, pays via Gateway nanopayments on Arc testnet, decision logic tied to real signals (price, balance, freshness, privacy policy). Working frontend plus architecture diagram. |
| Arc — Launch and Push to Mainnet | Same integration, with a mainnet config path documented and ready by 2026-09-30 (Arc mainnet opens 2026-09-16). |

Finalist criteria (Technicality, Originality, Practicality, Usability, WOW): the PQ receipt and sealed-request layer is the WOW; the standards leverage is the practicality.

## 3. Threat model for the privacy and PQ layer

1. **Portfolio disclosure.** The vault list in a scan request reveals holdings to the vendor, to TLS terminators, hosting proxies and logs, and to anyone recording traffic for harvest-now-decrypt-later. Mitigation: sealed requests (ML-KEM based).
2. **Unverifiable receipts.** Receipts signed with ECDSA cannot promise long-horizon verifiability to an auditor. Mitigation: ML-DSA-65 signatures over every receipt and attestation.
3. **Audit trail that leaks.** A public HCS log of queries would leak customers' interests. Mitigation: HCS stores commitments (hashes plus signatures), never content.
4. **Key substitution during discovery.** An attacker serving a fake agent card could swap keys. Mitigation: the ML-DSA public-key hash is bound in the ERC-8004 registration file that the on-chain identity points at; agent cards and receipts chain back to it.

Stated boundary (goes in README verbatim): x402 payment signatures (ECDSA on Hedera, EIP-3009 on Arc) and chain consensus remain classical. The PQ layer covers request confidentiality, the service's attestations, and the audit trail.

## 4. Architecture

```
                 ┌─────────────────────── The Graph ───────────────────────┐
                 │  Messari standardized subgraphs   The Graph Market      │
                 │  (yield 1.3.1, lending 3.1.0)     Substreams endpoint   │
                 └──────────┬──────────────────────────────┬───────────────┘
                            │ GraphQL (Studio key / x402)  │ erc4626-vault-metrics.spkg
                            ▼                              ▼  hosted sink → Postgres (Neon)
┌───────────────────────────────────────────────────────────────────────────┐
│ packages/service  (Express)                                                │
│  standardized query layer → unify → freshness → risk                       │
│  /hedera/v1/*  x402 via @x402/express + Blocky402 (HBAR / HTS USDC)        │
│  /arc/v1/*     x402 via @circle-fin/x402-batching (Gateway, USDC)          │
│  PQ: ML-KEM open, ML-DSA-65 sign receipts/attestations/agent card          │
│  HCS commitments  ·  ERC-8004 registration  ·  /.well-known/{agent,ucp}    │
└───────────────┬───────────────────────────────────────────┬───────────────┘
                │ 402 → pay → 200 + receipt                 │ receipts (public commitments)
                ▼                                           ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ packages/agent (Claude Agent │              │ packages/dashboard (Next.js) │
│ SDK, Circle starter kit)     │              │ catalog · freshness · scans  │
│ discover → quote → choose    │              │ payments per rail · HCS      │
│ rail+tier → seal → pay →     │              │ receipt verification         │
│ verify receipt → decide      │              └──────────────────────────────┘
└──────────────────────────────┘
```

Monorepo (bun workspaces for TypeScript; Cargo for the Substreams module):

```
vaultradar/
  substreams/erc4626-vault-metrics/   Rust Substreams package
  packages/core/                      shared: schema types, query templates, unify, freshness, risk, pq, receipts
  packages/service/                   x402-gated API, identity, HCS
  packages/agent/                     Claude Agent SDK agent
  packages/dashboard/                 Next.js thin UI
  skills/vaultradar/SKILL.md          how an agent uses the service (also installable as a Claude Code skill)
  scripts/                            verify-deployments, identity bootstrap, demo
  docs/                               spec, architecture.md (mermaid diagram), FEEDBACK notes
```

## 5. Components

### 5.1 Standardized data layer (`packages/core/standardized`)

- **Deployment registry** `deployments.json`: curated Messari deployments with `{ protocol, chain, schema: "yield-aggregator" | "lending", subgraphId, status, headLagSeconds, verifiedAt }`. Initial candidates: Aave v3 (Ethereum, Base), Compound v3 (Ethereum), Spark (Ethereum), Morpho-Aave v3 (Ethereum), Euler (Ethereum), Yearn v2 (Ethereum, Arbitrum), Convex, Aura, Arrakis, Gamma. The `verify-deployments` script queries `_meta { block { number timestamp } hasIndexingErrors }` on each and writes `headLagSeconds` and `status`: `live` when lag is at most 60 minutes, `stale` when it is larger, `down` when the query fails or reports indexing errors. Stale and down deployments stay in the registry on purpose so the freshness guard can demonstrate itself on real data. The same 60-minute threshold is used per request (section 5.3).
- **Query templates**, one per schema family, parameterized only by pagination: `yield.vaults` (Vault plus last 8 VaultDailySnapshot) and `lending.markets` (Market plus last 8 MarketDailySnapshot). Both include `_meta`. Exact field names are confirmed by schema introspection (`get_schema_by_deployment_id` or gateway introspection) in the first implementation task; the fields required are share price or exchange rate, TVL USD, input/output token, supply and deposit limits, snapshot timestamps and block numbers.
- **Gateway client**: `https://gateway.thegraph.com/api/subgraphs/id/<ID>` with the Studio API key. Optional mode `UPSTREAM_X402=1` uses `@graphprotocol/client-x402` against `https://gateway.thegraph.com/api/x402/subgraphs/id/<ID>` paying USDC on Base ($0.01 per query); used only for the "no API keys anywhere" demo segment.

### 5.2 ERC-4626 Substreams module (`substreams/erc4626-vault-metrics`)

- Rust package importing Pinax `erc4626` (its `map_events` decodes `Deposit`/`Withdraw` for every ERC-4626 vault by topic, no address list).
- Modules:
  - `map_vault_events`: consumes Pinax events; emits `VaultEvent { vault, block, timestamp, kind, sender, owner, assets, shares, implied_share_price }` with `implied_share_price = assets / shares` in decimal string form.
  - `store_vault_state`: per-vault stores for cumulative assets deposited and withdrawn, cumulative shares minted and burned, last implied share price, last event block, and a distinct-depositor counter (set-if-not-exists on `vault:owner` plus a per-vault add store).
  - `map_vault_metrics`: for vaults touched in the block, emits `VaultMetrics { chain_id, vault, block, timestamp, share_price, total_assets_est, total_shares_est, net_flow_assets, depositor_count, last_event_block }`. Every 300 blocks, for touched vaults, an `eth_call` batch to `totalAssets()` and `totalSupply()` refreshes an exact share price; results override the event-implied estimate.
  - `db_out`: `DatabaseChanges` for `substreams-sink-sql` with `schema.sql` defining `vault_metrics` (primary key `chain_id, vault, block`) and `vault_latest` (primary key `chain_id, vault`).
- Deployment: The Graph Market hosted sink to a Neon Postgres for Ethereum mainnet and Base. Fallback: `substreams-sink-sql` run locally against the same Market endpoint. Package published to substreams.dev as `erc4626-vault-metrics`.
- Build path for the demo: generated with the Substreams Skills from a single prompt, then reviewed and tested; the prompt and the diff after review are both kept in `docs/one-prompt.md`.

### 5.3 Unified view, freshness, risk (`packages/core`)

- `UnifiedVault { id: "<chainId>:<address>", kind: "yield-vault" | "lending-market" | "erc4626", protocol, chain, asset { symbol, decimals }, sharePrice, tvlUsd, history: [{ block, timestamp, sharePrice, tvlUsd }], sources: [{ kind: "messari" | "substreams", ref, block, timestamp, ageSeconds }], freshness: "fresh" | "stale" | "unavailable" }`.
- Freshness: `fresh` if the newest source block is at most 60 minutes behind chain head for Messari and 5 minutes for Substreams; `stale` otherwise; `unavailable` if the query failed or `_meta.hasIndexingErrors` is true. Chain head comes from the JSON-RPC provider per chain, cached 15 s.
- Risk flags: `share_price_drawdown` (1 h, 24 h, 7 d windows with thresholds 0.5 %, 2 %, 5 %), `tvl_outflow_24h` (net outflow above 20 % of TVL), `deposit_limit_reached`, `stale_data`. `RiskReport { vaultId, flags[], score 0–100, verdict: "ok" | "watch" | "alert" | "unavailable", evidence[] }`. Hard rule: if any source needed for a flag is `stale` or `unavailable`, the verdict is `unavailable` and evidence names the source and its age. No verdict is ever inferred from partial data.

### 5.4 PQ and receipt layer (`packages/core/pq`)

- Library: `@noble/post-quantum` 0.7.x only (public library; no code from prior projects).
- Signatures: ML-DSA-65 (default; `PQ_SIG_ALG=falcon512` selectable). Service signing key generated at first boot, stored in `keys/` with mode 0600, public key and its SHA-256 hash published.
- Sealed requests: service publishes a KEM public key. If the library exposes the X-Wing hybrid, use it; otherwise ML-KEM-768. Envelope `{ v: 1, kem: "xwing" | "ml-kem-768", ct, nonce, body }` where `body` is AES-256-GCM over canonical JSON of the request, key derived from the shared secret with HKDF-SHA-256 and info `"vaultradar/seal/v1"`. The vault count travels in a clear header `X-VR-Count` for pricing; identities stay sealed.
- Canonical JSON: deterministic key ordering and no whitespace (RFC 8785 style) via a small internal canonicalizer; hashes are SHA-256 over canonical bytes.
- Receipt: `{ v: 1, service: { erc8004: [{ chainId, agentId }], uaid }, request_hash, response_hash, sources: [{ ref, chainId, block, timestamp }], price: { amount, asset, rail }, payment: { rail: "hedera" | "arc", txId }, tier: "scan" | "table", issued_at, nonce, hcs: { topicId, sequence | null } }` plus `sig: { alg, pub_hash, value }`.
- Attestation (one per vault in a response): `{ v: 1, vaultId, chainId, block, timestamp, sharePrice, tvlUsd, source }` plus `sig`. Portable: a second agent verifies against the published key without buying.
- Verification tool: `bun run verify <receipt.json>` and an agent tool; both check signature, pub-hash binding to the ERC-8004 registration file, and recompute `response_hash` when the response body is present.

### 5.5 Service (`packages/service`)

- Express, bun runtime, Node 22 compatible.
- Public unpaid routes: `GET /.well-known/agent.json` (signed agent card: endpoints, prices, rails, PQ keys, ERC-8004 ids, UAID; signature in `X-VR-Signature`), `GET /.well-known/ucp` (UCP profile listing services and two x402 payment handlers), `GET /.well-known/erc8004.json` (registration file including `pq: { alg, pub_hash }`), `GET /v1/catalog` (covered protocols, vault count, prices), `GET /v1/receipts/:hash` (public commitment status including HCS sequence).
- Paid routes, mounted twice under `/hedera/v1` and `/arc/v1`, same handlers:
  - `POST /scan`: body is a sealed envelope or `{ vaults: ["<chainId>:<address>", ...] }` (clear mode allowed, flagged in the receipt). Price on Hedera: `$0.001 + $0.0005 × count` computed by the x402 v2 per-request price function reading `X-VR-Count`; the function also validates envelope structure so malformed sealed requests fail before payment. Price on Arc: Circle's middleware is static per route, so three bucketed routes `/scan/s` (1–5), `/scan/m` (6–20), `/scan/l` (21–100) at `$0.003`, `$0.01`, `$0.05`. Response: `{ vaults, reports, attestations, receipt }`.
  - `POST /table`: body `{ protocol, chainId }`, flat `$0.01` on both rails. Returns every vault of that protocol with reports, attestations and receipt. Privacy tier: the vendor learns only the protocol.
- Hedera rail: `@x402/express` + `@x402/core` + `@x402/hedera` at one pinned 2.x version; facilitator `https://api.testnet.blocky402.com`; settlement asset HTS USDC `0.0.429274` (HBAR route variant kept for the harness test). Arc rail: `@circle-fin/x402-batching` `createGatewayMiddleware` against Circle's testnet Gateway facilitator, network `eip155:5042002`.
- After settlement: build and sign receipt, respond, then enqueue an HCS message `{ receipt_hash, sig, issued_at }` to the service topic via `TopicMessageSubmitTransaction`; retry with backoff; `GET /v1/receipts/:hash` reports the sequence number when confirmed.
- Identity bootstrap `scripts/identity.ts`: create HCS topic; register in ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e` on Hedera testnet (chain 296) and Arc testnet (chain 5042002) with `agentURI` pointing at `/.well-known/erc8004.json`; compute HCS-14 UAID with `@hashgraphonline/standards-sdk`; write ids to `service.config.json`.
- Logging never includes decrypted bodies. Rate limit 60 requests per minute per IP on paid routes.
- Hosting: any public host with a stable URL (Fly.io or Railway); testnet keys via environment variables; `.env.example` documents every variable.

### 5.6 Agent (`packages/agent`)

- Derived from `circlefin/agent-stack-starter-kits` Claude Agent SDK variant (public starter kit). Model: latest Claude via the Anthropic API.
- Wallets: Hedera testnet ECDSA account (`@x402/fetch` + `@x402/hedera` signer) and Arc testnet key with a Gateway deposit (`GatewayClient`). Circle CLI is used for the Arc wallet setup and balance checks.
- Tools: `discover(url)` (fetch card, verify PQ signature, cross-check pub hash against the registration file and the on-chain `agentURI`), `quote(request)` (unpaid 402 probe per rail), `pay_and_scan(request, policy)` (choose rail by `rail_preference` and balances, choose tier by `privacy`, seal, pay, verify receipt, persist), `verify_receipt`, `explain`.
- Policy file `policy.json`: `{ budget: { hbar, usdc_hedera, usdc_arc }, privacy: "strict" | "balanced" | "cheap", rail_preference: "cheapest" | "hedera" | "arc" }`. `strict` always buys `table`; `balanced` seals `scan`; `cheap` allows clear `scan`.
- Behavior: given a watchlist or wallet, budget the session, buy data, reason over `RiskReport`s, and output a decision per vault (`hold`, `withdraw`, `rebalance`, `insufficient data`) with citations: block numbers, deployment or package refs, payment tx ids, receipt hash, HCS sequence. Any `unavailable` verdict yields `insufficient data`, never a guess.
- Interfaces: CLI (`bun run agent watch --vaults ... --policy policy.json`) and an interactive chat mode. Optional tool: the official Subgraph MCP for ad-hoc deployment discovery.

### 5.7 Dashboard (`packages/dashboard`)

Next.js app reading the service's public endpoints and the agent's local JSON log. Pages: catalog and freshness per source, scans with verdicts and evidence, payments per rail with HashScan and Arcscan links, HCS commitments, and a receipt verifier (paste a receipt, see the PQ check). No auth. Satisfies Arc's "working frontend".

### 5.8 Hedera Harness PR

Fork `hedera-dev/hedera-harness`. Changes: associate HTS tokens for the ephemeral signer (issue #15); add a validation check that, given a URL, asserts an x402 v2 `PAYMENT-REQUIRED` for `hedera:testnet`, pays with the ephemeral signer through Blocky402, and confirms the settlement tx on the mirror node. Tests and README section included. PR opened before submission; link and a short clip in the VaultRadar README.

## 6. Data flow for one paid request

1. Agent calls `discover`; verifies the card's ML-DSA signature and the key binding via the ERC-8004 registration file and on-chain `agentURI`.
2. Agent builds the scan request, seals it, and POSTs to `/hedera/v1/scan` with `X-VR-Count`.
3. Service returns 402 with `PAYMENT-REQUIRED` (exact scheme, `hedera:testnet`, HTS USDC, amount from the price function).
4. Agent signs a Hedera `TransferTransaction` whose transaction id names the Blocky402 fee payer, retries with `PAYMENT-SIGNATURE`.
5. Middleware calls Blocky402 `/verify` and `/settle`; on success the handler runs.
6. Handler opens the envelope, runs the standardized queries and the Postgres read, unifies, computes freshness and risk, signs attestations and the receipt, responds with `PAYMENT-RESPONSE` and the payload.
7. Service enqueues the HCS commitment; agent verifies the receipt, stores it, reasons, and prints the decision.

The Arc path differs only in steps 3 to 5: Gateway middleware, EIP-3009 authorization, batched settlement.

## 7. Error handling

- Upstream subgraph error, timeout, or indexing errors: source marked `unavailable`; verdicts depending on it become `unavailable`; the receipt lists the failed source.
- Substreams sink lag beyond 5 minutes: source `stale`; same rule.
- Payment verify or settle failure: standard x402 402/4xx; agent retries once on transient errors, then reports.
- Sealed envelope malformed: rejected at quote time (before payment). Decryption failure after payment: HTTP 422 with a receipt marked `error`; no refund path (documented limitation).
- HCS submit failure: retried with backoff; the response is never blocked on HCS; `hcs.sequence` is null until confirmed.
- Chain head RPC failure: freshness falls back to `stale` for all sources on that chain.

## 8. Testing

- Unit (bun test): canonical JSON, PQ sign/verify and seal/open round trips, freshness thresholds, risk rules including the "unavailable on partial data" rule, price function, receipt hash recomputation.
- Substreams: `substreams run` over a fixed block range with a snapshot of expected `VaultMetrics` for two known vaults; `substreams gui` used for manual checks.
- Integration (env-gated, live testnets): one paid `scan` on Hedera, one on Arc, receipt verification, HCS sequence confirmed via mirror node.
- End to end: `scripts/demo.sh` runs discover, quote, paid scan on each rail, verification, and prints the decision; used for the video.

## 9. Deliverables and success criteria

1. Real paid request on Hedera testnet via Blocky402, visible on HashScan, with an HCS commitment.
2. Real paid request on Arc testnet via Gateway, visible on Arcscan.
3. A scan returning at least three Messari-covered protocols plus at least one ERC-4626 vault not covered by Messari, all from live sources, with per-source block heights.
4. `erc4626-vault-metrics` published on substreams.dev and running through The Graph Market on two chains.
5. ML-DSA-65 receipt verification and sealed-request round trip demonstrated.
6. Agent decision with citations, and a demonstrated refusal on a stale deployment.
7. Harness PR opened.
8. README with architecture diagram, payment flow, "what the standards made easier", PQ boundary statement, run instructions; `SKILL.md`; 2–4 minute video with no AI voiceover; continuous commit history from 2026-09-04.

## 10. Schedule and cut order

| Date | Focus |
|---|---|
| Sept 5 | Accounts and keys (Studio, Hedera, Arc, Circle CLI, Neon), verify deployments, hello-x402 paid request on Hedera, repo skeleton |
| Sept 6–7 | Substreams module and hosted sink ∥ service data layer, Hedera rail, PQ receipts |
| Sept 8–9 | Agent, sealed requests, policy ∥ dashboard ∥ Arc rail |
| Sept 10 | HCS, identity, UCP, privacy tiers, harness PR |
| Sept 11 | README, SKILL.md, diagram, tests, spkg publish, dry run |
| Sept 12 | Video, submission |

Cut order if behind: harness PR, then privacy `table` tier, then Arc rail and dashboard, then sealed requests. PQ receipts are never cut.

## 11. Out of scope

On-chain PQ payment signatures; zero-knowledge proofs of risk computation; A2A negotiation; scheduled or streamed payments; ENS; mainnet money beyond a few dollars of USDC on Base for the optional upstream x402 demo.
