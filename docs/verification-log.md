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

### Hedera rail

One sealed scan of one vault, priced at 0.0015 USDC (0.001 + 0.0005 × 1).

```
transaction  0.0.7162784@1789169558.289173297
payer        0.0.10463726   −1500 atomic units of HTS USDC 0.0.429274
payTo        0.0.10463666   +1500 atomic units
result       SUCCESS            consensus 1789169584.294669104
```

[HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1789169558-289173297) ·
[mirror node JSON](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789169558-289173297)

The client verified the returned receipt, opened the sealed reply, and printed the signed
per-vault attestation inside it.

### Arc rail

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
