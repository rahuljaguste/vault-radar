# Verification log

Everything below was observed against the deployed system, not computed from the code. Each row
says what was checked, what came back, and where a reader can check it independently. The
explorer links are for people; the mirror-node and gateway links are the ones to use from a
script, because HashScan and Arcscan are client-rendered apps that answer 404 to a plain
`curl`.

Service: <https://vaultradar-service-production.up.railway.app> ·
Dashboard: <https://vaultradar-dashboard-production.up.railway.app>

## Deployed subgraphs — the verification gate

`bun run verify-deployments` queries each registered deployment's `_meta` and pins what it
finds. Run against the live gateway:

```
live 11, stale 1, down 3 / 15 total     14 of 15 deployment ids pinned
```

The three that are down are an upstream fact, not a defect: convex-finance and aura-finance on
Ethereum last indexed years ago, and aave-v3 on Base resolves to no allocations, so there is no
deployment id to pin. Vaults under a dead registration come back `unavailable` rather than
silently stale. The live data path itself:

| Query | Result |
| --- | --- |
| `yearn-v2` on Ethereum | 194 vaults, freshness `fresh`, 32-point history |
| `aave-v3` on Ethereum | 67 vaults, freshness `fresh` |
| `erc4626` on Ethereum | 500 vault ids served from the Substreams sink |

## On-chain identity

The service's ML-DSA-65 public-key hash is written as ERC-8004 metadata under `pq.sig.pubhash`
at registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, which is deployed at the same address
on both testnets.

| | Hedera (chain 296) | Arc (chain 5042002) |
| --- | --- | --- |
| Agent id | `112` | `894342` |
| Registration tx | `0x0f23d2a0c2c3a820e69e4304027f5d442c6ae4a8cff1147a6ea8b4e5bda9ca3a` | `0x0ebaa26fbf5c6db6f99eee116deccdef0aa766b7fad4d24bcb819e087b82ffc2` |
| Explorer | <https://hashscan.io/testnet/transaction/0x0f23d2a0c2c3a820e69e4304027f5d442c6ae4a8cff1147a6ea8b4e5bda9ca3a> | <https://testnet.arcscan.app/tx/0x0ebaa26fbf5c6db6f99eee116deccdef0aa766b7fad4d24bcb819e087b82ffc2> |

Both anchors were read back and compared against the live agent card's `pq.sig.pub_hash`:

```
card pub_hash : dd4a56bffd570c901648dcac7261d5bc38c079a139f3bc0e26c619a138cbf2e1
chain 296     : matches
chain 5042002 : matches
```

The agent's own `discover()` — the code path that decides whether to pay — reports
`cardSignatureValid: true`, `keyBindingValid: true`, and both identities matching.

## Settled payments

Nine paid requests have settled: eight on Hedera, one on Arc. Every row below was read back
rather than copied from the run records — the transactions from the Hedera mirror node, the
receipt hashes from the deployed service, which still serves each one.

All eight Hedera transactions are `SUCCESS`, all eight move HTS USDC `0.0.429274` from payer
`0.0.10463726` to pay-to `0.0.10463666`, and all eight are submitted by the same facilitator
account `0.0.7162784`, which is why the ids share a prefix.

| Paid for | USDC | Transaction | Receipt | Consensus (UTC) |
| --- | --- | --- | --- | --- |
| one sealed vault scan | 0.0015 | [`0.0.7162784@1789169558.289173297`](https://hashscan.io/testnet/transaction/0.0.7162784-1789169558-289173297) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789169558-289173297) | [`50bddf81`](https://vaultradar-service-production.up.railway.app/v1/receipts/50bddf81474ad98fca492c1f640a695ea525342dc4cef85c2f5ff0704ff50cbc) | 2026-09-11 23:33:04 |
| one sealed vault scan | 0.0015 | [`0.0.7162784@1789174355.527711263`](https://hashscan.io/testnet/transaction/0.0.7162784-1789174355-527711263) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789174355-527711263) | [`8b2c14e9`](https://vaultradar-service-production.up.railway.app/v1/receipts/8b2c14e908f2a4f90ba20907a3462a603c60fee64a7002d67110e91dcbdfc924) | 2026-09-12 00:52:50 |
| the strict-tier table | 0.06 | [`0.0.7162784@1789174499.520253147`](https://hashscan.io/testnet/transaction/0.0.7162784-1789174499-520253147) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789174499-520253147) | [`666a8f86`](https://vaultradar-service-production.up.railway.app/v1/receipts/666a8f86e15003bdcd63fe6daab4e34085b4e8839304c680f56887a4f8868ff9) | 2026-09-12 00:55:12 |
| a 100-vault sealed scan | 0.051 | [`0.0.7162784@1789174549.473281947`](https://hashscan.io/testnet/transaction/0.0.7162784-1789174549-473281947) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789174549-473281947) | [`799fe27f`](https://vaultradar-service-production.up.railway.app/v1/receipts/799fe27f262e04967f1a703be7d217b77ebf2b2ced20fcb3abdd4a8192e7a3a0) | 2026-09-12 00:56:08 |
| a 100-vault sealed scan | 0.051 | [`0.0.7162784@1789174993.567530846`](https://hashscan.io/testnet/transaction/0.0.7162784-1789174993-567530846) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789174993-567530846) | [`0dc9ee02`](https://vaultradar-service-production.up.railway.app/v1/receipts/0dc9ee02fe31a0f1aed46cb8b89e0fdeccea10352287264710f325c0e9957c08) | 2026-09-12 01:03:34 |
| a 100-vault sealed scan | 0.051 | [`0.0.7162784@1789175488.013994200`](https://hashscan.io/testnet/transaction/0.0.7162784-1789175488-013994200) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789175488-013994200) | [`70957716`](https://vaultradar-service-production.up.railway.app/v1/receipts/70957716b5d83a3bfd2bd6cb9a8f5e6f07663c64abdff2e3af5195b1d7c8dd53) | 2026-09-12 01:11:44 |
| a 100-vault sealed scan | 0.051 | [`0.0.7162784@1789175602.112134940`](https://hashscan.io/testnet/transaction/0.0.7162784-1789175602-112134940) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789175602-112134940) | [`8b37ccbf`](https://vaultradar-service-production.up.railway.app/v1/receipts/8b37ccbfb4727a87a2b45ad854152d268b170b58a4f1236a02be0de4548d1563) | 2026-09-12 01:13:38 |
| a 100-vault sealed scan | 0.051 | [`0.0.7162784@1789176159.407789041`](https://hashscan.io/testnet/transaction/0.0.7162784-1789176159-407789041) · [mirror](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789176159-407789041) | [`c67e8437`](https://vaultradar-service-production.up.railway.app/v1/receipts/c67e843747d707cb27e96c580faa2017e19f24e43db132b6a66270710cb1e95e) | 2026-09-12 01:22:58 |
| **total** | **0.318** | | | |

The amounts are the pricing constants as they land on chain, which is the check that the quote
the client enforced and the charge the facilitator signed are the same number: `0.0015` is
`0.001 + 0.0005 × 1` and `0.051` is that formula at a hundred vaults, both
`hederaScanPriceUsd` in `packages/core/src/pricing.ts`, and the strict tier's whole-protocol
table is the flat `TABLE_PRICE_USD` of `0.06` in the same file.

The five 100-vault scans are the ones worth clicking: each bought a sealed verdict for every
vault under the two live Messari registrations in one request, and the price rose with the
count, which a single-vault example cannot show.

### One in full

The first row, as the mirror node returns it:

```
transaction  0.0.7162784@1789169558.289173297
payer        0.0.10463726   −1500 atomic units of HTS USDC 0.0.429274
payTo        0.0.10463666   +1500 atomic units
result       SUCCESS            consensus 1789169584.294669104
```

The client verified the returned receipt, opened the sealed reply, and printed the signed
per-vault attestation inside it.

### Arc rail

The ninth. 2 USDC deposited into Circle Gateway, then a 0.003 USDC sealed scan. Gateway batches
settlement, so a payment's own reference is a batch id rather than a transaction hash:

2 USDC deposited into Circle Gateway, then a 0.003 USDC sealed scan. Gateway batches settlement,
so a payment's own reference is a batch id rather than a transaction hash:

```
approval tx  0xcb3e84eb2c788e46cb5ae5110a7b50fc4d8f85d84b2ebd398c50a6d50e54c949
deposit tx   0xe253e739cd2ca42c11c841db8d6891470ee0d22bff5ba30acb75c453ce35ac64
payment      batch reference cbc2021d-d57e-4e05-b43f-56707a532f33, receipt ok, reply opened
```

[approval](https://testnet.arcscan.app/tx/0xcb3e84eb2c788e46cb5ae5110a7b50fc4d8f85d84b2ebd398c50a6d50e54c949) ·
[deposit](https://testnet.arcscan.app/tx/0xe253e739cd2ca42c11c841db8d6891470ee0d22bff5ba30acb75c453ce35ac64)

## HCS audit trail

Each settled request enqueues `{ v, receipt_hash, sig, issued_at }` to topic `0.0.10483981`.
The ML-DSA-65 signature is larger than the topic's message limit, so the queue chunks it and the
reader reassembles on lookup. One committed receipt, looked up through the service:

```
GET /v1/receipts/50bddf81474ad98fca492c1f640a695ea525342dc4cef85c2f5ff0704ff50cbc
→ { topicId: "0.0.10483981", sequence: "10", consensus_timestamp: "1789168622.245410844" }
```

[Topic on the mirror node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10483981/messages?limit=10&order=desc)

## Substreams sink

The ERC-4626 module is published as
[`erc4626-vault-metrics@v0.1.0`](https://substreams.dev/packages/erc4626-vault-metrics/v0.1.0)
and runs as a sink in the same project, writing into the Postgres the service reads. Observed
while catching up:

```
cursor block  25,957,527   (chain head 25,957,608 — 81 blocks behind)
rows written  190,220      (~79 rows/s)
```

## Test suite

```
bun test        464 pass, 1 skip, 0 fail
bun run typecheck  exit 0 across core, service, agent and dashboard
```
