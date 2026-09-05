# VaultRadar architecture

Two diagrams: the system view and the flow of one paid request on the Hedera rail. Rendered PNGs live next to this file (`architecture.png`, `payment-flow.png`); regenerate with `node scripts/render-diagrams.mjs`.

## System view

```mermaid
flowchart TB
  subgraph GRAPH["The Graph"]
    direction TB
    MESSARI["Messari standardized subgraphs<br/>yield-aggregator 1.3.1 · lending 3.1.0<br/>pinned by deployment ID"]
    MARKET["The Graph Market<br/>Substreams endpoint · hosted sink"]
    PINAX["Pinax erc4626 package<br/>Deposit / Withdraw events"]
    SPKG["erc4626-vault-metrics.spkg (Rust)<br/>share price · flows · depositors · eth_call refresh"]
    PINAX -->|imported as dependency| SPKG
    SPKG -->|runs on Ethereum + Base| MARKET
  end

  NEON[("Neon Postgres<br/>vault_metrics · vault_latest · vault_meta")]
  MARKET -->|hosted sink| NEON

  subgraph SERVICE["packages/service — Express on bun"]
    direction TB
    QUERY["Standardized query layer<br/>one template per schema family"]
    UNIFY["Unify · freshness · risk<br/>UnifiedVault → RiskReport"]
    PQ["PQ layer<br/>ML-KEM-768+X25519 seal/open<br/>ML-DSA-65 receipts · attestations · card"]
    HRAIL["POST /hedera/v1/scan · /table<br/>@x402/express + per-request price"]
    ARAIL["POST /arc/v1/scan/s|m|l · /table<br/>@circle-fin/x402-batching"]
    WK["GET /.well-known/agent.json · ucp · erc8004.json<br/>GET /v1/catalog · /v1/receipts/:hash"]
    QUERY --> UNIFY --> PQ
    HRAIL --> PQ
    ARAIL --> PQ
  end

  MESSARI -->|GraphQL, Studio key or x402 on Base| QUERY
  NEON -->|SQL read| QUERY

  subgraph HEDERA["Hedera testnet"]
    B402["Blocky402 facilitator<br/>verify · settle"]
    USDC_H["HTS USDC 0.0.429274"]
    HCS["HCS topic<br/>receipt_hash + ML-DSA sig"]
    ERC_H["ERC-8004 IdentityRegistry<br/>agentURI + pq.sig.pubhash"]
  end

  subgraph ARC["Arc testnet"]
    GW["Circle Gateway facilitator<br/>EIP-3009 · batched settle"]
    USDC_A["USDC (also gas)"]
    ERC_A["ERC-8004 IdentityRegistry<br/>agentURI + pq.sig.pubhash"]
  end

  HRAIL <-->|/verify then /settle| B402
  B402 --> USDC_H
  ARAIL <-->|verify then settle| GW
  GW --> USDC_A
  PQ -->|commitment after 2xx| HCS
  SERVICE -.->|identity bootstrap| ERC_H
  SERVICE -.->|identity bootstrap| ERC_A

  subgraph AGENT["packages/agent — Claude Agent SDK on Circle starter kit"]
    direction TB
    TOOLS["discover → quote → choose rail + tier<br/>seal → pay → open → verify → decide"]
    POLICY["policy.json<br/>budget · privacy · rail_preference · max_age_seconds"]
    WALLETS["Hedera ECDSA account<br/>Arc key + Gateway deposit"]
    RUNS[("runs/&lt;id&gt;.json")]
    POLICY --> TOOLS
    WALLETS --> TOOLS
    TOOLS --> RUNS
  end

  TOOLS -->|402 → pay → 200 sealed body + receipt| HRAIL
  TOOLS -->|402 → pay → 200 sealed body + receipt| ARAIL
  TOOLS -->|card + key hash check| WK
  TOOLS -.->|read pq.sig.pubhash| ERC_H
  TOOLS -.->|read pq.sig.pubhash| ERC_A

  subgraph DASH["packages/dashboard — Next.js"]
    UI["catalog · freshness · runs · payments per rail<br/>HCS commitments · receipt verifier"]
  end
  WK --> UI
  RUNS --> UI

  subgraph HARNESS["hedera-dev/hedera-harness PR"]
    PROBE["Tier 3.5 x402Probe validator<br/>402 → pay via Blocky402 → mirror-node confirm"]
  end
  PROBE -->|POST /hedera/v1/scan-hbar| HRAIL
```

## One paid request, Hedera rail

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant S as VaultRadar service
  participant F as Blocky402 facilitator
  participant G as The Graph (Messari + sink)
  participant H as Hedera (HTS USDC · HCS)
  participant R as ERC-8004 registry

  A->>S: GET /.well-known/agent.json
  S-->>A: card + ML-DSA signature
  A->>R: getMetadata(agentId, "pq.sig.pubhash")
  R-->>A: hash
  Note over A: verify card signature, compare hash, pin key

  Note over A: seal { request, reply_pk, payer, ts, req_nonce }
  A->>S: POST /hedera/v1/scan (X-VR-Count, sealed envelope)
  S-->>A: 402 PAYMENT-REQUIRED (exact, hedera:testnet, USDC, amount = 0.001 + 0.0005 × n)
  Note over A: sign TransferTransaction naming Blocky402 fee payer
  A->>S: POST again with PAYMENT-SIGNATURE
  S->>F: /verify
  F-->>S: valid
  Note over S: open envelope, check ts, nonce, payer, count
  S->>G: standardized queries by deployment ID + SQL read
  G-->>S: vaults, snapshots, _meta blocks, sink cursor
  Note over S: unify → freshness → risk → sign attestations
  Note over S: seal { vaults, reports, attestations } to reply_pk, sign receipt
  S-->>A: 200 sealed body + receipt + PAYMENT-RESPONSE (tx id)
  S->>F: /settle
  F->>H: submit transfer (fee payer signs)
  S->>H: HCS message { receipt_hash, sig, issued_at }
  Note over A: open response, verify receipt + attestations, apply own max_age check, decide
  A->>S: GET /v1/receipts/{hash}
  S-->>A: { sequence, consensus_timestamp }
```
