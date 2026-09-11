---
name: vaultradar
description: Buy cross-protocol vault risk data over x402 with sealed requests and verify PQ-signed receipts
---

# VaultRadar

VaultRadar sells per-request risk reports on ERC-4626 vaults, Messari yield-aggregator vaults, and Messari lending markets. You pay per request over x402, on Hedera testnet or Arc testnet. Requests and responses are sealed with a hybrid post-quantum KEM. Receipts and per-vault attestations are signed with ML-DSA-65.

Service: `<<FILL: deployed service URL, e.g. https://vaultradar.fly.dev>>`

## When to use this

Use VaultRadar when you need a fresh, citable risk read on specific vaults and you are willing to pay cents for it. Good fits:

- Monitoring a wallet's vault positions for share-price drawdown or deposit outflow.
- Deciding whether to hold, withdraw, or rebalance, with block-level evidence attached to the decision.
- Producing an audit trail a third party can verify later, without trusting your own logs.

Do not use it as a price oracle or a TVL feed. It answers "is this vault behaving abnormally, as of which block", and it refuses to answer at all when its data is stale.

## Discovery and key binding

Fetch the agent card, then verify two things before you send anything sensitive.

```bash
curl -s "$SERVICE_URL/.well-known/agent.json" | jq '{pq, erc8004, endpoints, prices, limits}'
```

1. **The card signs itself.** Strip the `sig` field, canonicalize the rest, and verify `sig.value` as an ML-DSA-65 signature under `pq.sig.public_key`. Canonical JSON here means sorted keys, no whitespace, all numerics as strings. `checkSig` in `@vaultradar/core` does this.
2. **The key is anchored on chain.** For each entry in `card.erc8004`, call `getMetadata(agentId, "pq.sig.pubhash")` on the ERC-8004 IdentityRegistry at `0x8004A818BFB912233c491871b3d84c89A494BD9e`. The registry is at that address on both Hedera testnet (chain 296, via `https://testnet.hashio.io/api`) and Arc testnet (chain 5042002, via `https://rpc.testnet.arc.io`). The returned bytes hold the hash as a UTF-8 hex string. Compare it to `card.pq.sig.pub_hash`.

A mismatch means the card is forged or the key rotated. An RPC failure means "could not verify", which is not the same as a mismatch. Treat the two differently. `VaultRadarClient.discover()` reports `matches: false` for the first and `matches: null` for the second.

Once verified, pin `pq.sig.public_key` locally. You can verify every future receipt against the pinned key without touching a chain again.

## Sealing a request

The request body is a sealed envelope:

```json
{ "v": 1, "kem": "ml-kem768-x25519", "kid": "<8-byte hex from card.pq.kem.kid>",
  "ct": "<base64 KEM ciphertext>", "nonce": "<base64 12-byte AES-GCM nonce>",
  "body": "<base64 AES-256-GCM ciphertext>" }
```

The plaintext inside `body` is canonical JSON of:

| Field | Value |
|---|---|
| `request` | `{ "vaults": ["<chainId>:<0x address>"] }` for a scan, or `{ "protocol": "...", "chainId": "..." }` for a table |
| `reply_pk` | base64 ML-KEM-768 + X25519 public key you generate fresh for this one request |
| `payer` | the account that will pay: a Hedera account id like `0.0.12345`, or an Arc `0x` address |
| `ts` | Unix seconds, as a string |
| `req_nonce` | 16 random bytes, lowercase hex, 32 characters |

Sealing is ML-KEM-768 combined with X25519, shared secret through HKDF-SHA-256 with info `vaultradar/seal/v1`, then AES-256-GCM. Use `@noble/post-quantum` 0.7.1, or `buildSealedRequest` from `@vaultradar/core`.

Rules the service enforces, each of which costs you nothing if you fail it:

- `ts` must be within **120 seconds** of server time. Seal immediately before you send.
- `req_nonce` must not have been seen in the last **10 minutes**. Never reuse one, even on a retry after a 402.
- `payer` must equal the account the payment layer actually verified.
- The clear header `X-VR-Count` must equal `request.vaults.length` on a scan route. It is the only thing about your request that travels unencrypted, because the price depends on it.

Generate a new `reply_pk` per request. Reusing one across requests means one compromised secret opens every past response.

## The 402 flow

### Hedera rail

Packages: `@x402/fetch` 2.25.0, `@x402/hedera` 2.25.0, `@x402/core` 2.25.0.

1. POST the sealed envelope to `card.endpoints.hedera.scan` with `X-VR-Count`.
2. The service answers 402 with a `PAYMENT-REQUIRED` header. It is base64 of JSON, listing scheme `exact`, network `hedera:testnet`, the `payTo` account, the asset, and the computed amount.
3. Sign a Hedera `TransferTransaction` naming the Blocky402 facilitator as fee payer, and repeat the POST with a `PAYMENT-SIGNATURE` header.
4. On 200, read the settled transaction id from the `PAYMENT-RESPONSE` header, base64 of JSON with a `transaction` field.

`wrapFetchWithPayment(fetch, client)` from `@x402/fetch` does steps 2 through 4 for you, given an `x402Client` registered with `ExactHederaScheme`.

Your account and the service's `payTo` account must both be associated with the HTS USDC token the service prices in, `0.0.429274` on testnet. You need HBAR for your own signature. The facilitator pays the network fee.

### Arc rail

Package: `@circle-fin/x402-batching` 3.4.0.

Arc routes are bucketed by count, because Circle's middleware is static per route. Pick the bucket yourself before you send: `s` for 1 to 5 vaults, `m` for 6 to 20, `l` for 21 to 100. Posting to the wrong bucket returns 422 `bucket_mismatch`.

`GatewayClient.pay(url, { method, body, headers })` signs an EIP-3009 authorization and retries. Settlement is batched, so the transaction reference in the receipt may settle shortly after your 200.

You need Arc testnet USDC deposited to Gateway. Arc gas is USDC too.

## Opening the response and verifying

A sealed response is `{ sealed: { v, kem, kid, ct, nonce, body }, receipt }`. Decapsulate with the secret half of the `reply_pk` you generated, and the plaintext is `{ vaults, reports, attestations }`. A clear-mode response is `{ vaults, reports, attestations, receipt }` with no envelope, and the receipt records `sealed: false`.

Verify in this order. Stop at the first failure and treat the whole result as unusable.

1. **Receipt signature.** Strip `sig`, canonicalize, verify under the pinned `pq.sig.public_key`. Check `sig.pub_hash` still equals the hash you anchored on chain.
2. **Response hash.** Recompute SHA-256 over canonical `{ vaults, reports, attestations }` and compare to `receipt.response_hash`. This is what binds the receipt to the body you were actually handed.
3. **Request hash.** Recompute SHA-256 over canonical `request`, the same object you sealed, and compare to `receipt.request_hash`. This proves the service answered your question, not a different one.
4. **Every attestation.** Each is `{ v, vaultId, chainId, block, timestamp, sharePrice, tvlUsd, source, sig }`, signed individually. Verify each under the same key. One bad signature invalidates the batch.
5. **The counts must match.** `attestations.length` must equal `vaults.length` and `reports.length`. Every vault in the body must have exactly one report and exactly one attestation, keyed by the same `vaultId`. If a vault you asked for is absent from the response, that vault is `insufficient data`. Never read an absent vault as healthy.

Attestations stay valid on their own after you discard the sealed body, so keep them if you need to cite one vault's data later.

Look the receipt's HCS commitment up by hash. The sequence number is null until Hedera consensus confirms it, which is normal for the first few seconds.

```bash
curl -s "$SERVICE_URL/v1/receipts/$RECEIPT_HASH" | jq
```

`RECEIPT_HASH` is SHA-256 over the canonical receipt with `sig` removed.

## Freshness is your job too

The service marks each source `fresh`, `stale`, or `unavailable`, and refuses to produce a verdict when any source it needed was not fresh. Its thresholds are 60 minutes behind chain head for a Messari subgraph, and 5 minutes for the Substreams sink.

Do not rely on that alone. Check each attestation's `timestamp` against your own `max_age_seconds` on your own clock. A service that is compromised, misconfigured, or simply wrong about chain head will still hand you a `fresh` label. An attestation older than your own bound is `insufficient data`, whatever the label says.

A verdict of `unavailable` is also `insufficient data`. It is never a weak `ok`.

## Prices

| Route | Tier | Price |
|---|---|---|
| `POST /hedera/v1/scan` | scan, metered | $0.001 + $0.0005 per vault, in HTS USDC `0.0.429274` |
| `POST /hedera/v1/scan-hbar` | scan, metered | 0.01 HBAR per vault |
| `POST /hedera/v1/table` | table | $0.06 flat |
| `POST /arc/v1/scan/s` | scan, 1 to 5 vaults | $0.003 |
| `POST /arc/v1/scan/m` | scan, 6 to 20 vaults | $0.01 |
| `POST /arc/v1/scan/l` | scan, 21 to 100 vaults | $0.05 |
| `POST /arc/v1/table` | table | $0.06 flat |

The `table` tier returns every vault of one protocol on one chain, so the vendor never learns which of them you hold. It is priced above a sealed scan on purpose, so privacy is never the cheap option by accident: $0.06 is above the $0.051 a scan of the maximum 100 vaults costs.

Maximum 100 vaults per scan.

## Errors

A 4xx from the handler costs you nothing. The payment rails settle only after a 2xx.

| Status | `reason` | Meaning |
|---|---|---|
| 400 | `bad_count` | `X-VR-Count` missing, not an integer, or outside 1 to 100 |
| 400 | `malformed_envelope` | Body looks like an envelope but is not a valid one |
| 422 | `envelope_open_failed` | Wrong `kid`, corrupt ciphertext, or a malformed plaintext field |
| 422 | `payer_unknown` | The payment layer did not attach a verified payer |
| 422 | `ts_window` | `ts` more than 120 seconds from server time |
| 422 | `nonce_replay` | `req_nonce` seen within the last 10 minutes |
| 422 | `payer_mismatch` | Envelope `payer` is not the account that paid |
| 422 | `count_mismatch` | `X-VR-Count` does not equal `request.vaults.length` |
| 422 | `bad_vaults` | Empty list, over 100 entries, or an id not matching `<chainId>:<0x40 hex>` |
| 422 | `bad_table_request` | `protocol` or `chainId` missing or not a string |
| 422 | `bucket_mismatch` | Arc only: the count does not belong to this route's bucket |
| 502 | `upstream_failed` | A subgraph or the sink database failed |
| 504 | `handler_cap` | Data gathering exceeded the 60 second cap, nothing settled |

On 502 or 504, retry once. Both are transient by nature and neither charged you.

## Example: see the 402 without paying

Post an unpaid request and decode the price the service is asking for.

```bash
SERVICE_URL=${SERVICE_URL:-http://localhost:8787}

curl -s -o /tmp/vr-402.json -D /tmp/vr-402.hdr \
  -X POST "$SERVICE_URL/hedera/v1/scan" \
  -H 'content-type: application/json' \
  -H 'x-vr-count: 3' \
  -d '{"vaults":[
        "1:0x0000000000000000000000000000000000000001",
        "1:0x0000000000000000000000000000000000000002",
        "8453:0x0000000000000000000000000000000000000003"]}'

tr -d '\r' < /tmp/vr-402.hdr \
  | awk 'tolower($1) == "payment-required:" { print $2 }' \
  | { read -r b64; printf '%s' "$b64" | base64 --decode 2>/dev/null \
      || printf '%s' "$b64" | base64 -D; } \
  | jq
```

Expect HTTP 402 and a decoded body naming scheme `exact`, network `hedera:testnet`, the service's `payTo` account, the USDC asset it prices in, and an amount of `2500` atomic units. That is $0.0025, the metered price for three vaults.

Note that the clear body above is accepted at the 402 stage. The price function only checks the count header and the envelope's shape. Seal the real request before you pay for it.
