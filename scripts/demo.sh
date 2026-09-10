#!/usr/bin/env bash
#
# VaultRadar end-to-end demo. This doubles as the script for the submission video.
#
# Run against a local service:
#   bun run service &
#   bash scripts/demo.sh
#
# Run against the deployed service:
#   SERVICE_URL=https://vaultradar.fly.dev bash scripts/demo.sh
#
# Steps 3, 4 and 5 drive pieces that are specified but not yet built (the agent CLI
# from Tasks 22 and 23, the Arc rail and its hello-arc client from Task 19). The
# commands below are the contract those tasks implement, so they are written out in
# full. Until the files exist the script prints the command instead of running it,
# rather than aborting, so the earlier and later steps still demo.

set -euo pipefail

SERVICE_URL="${SERVICE_URL:-http://localhost:8787}"
SERVICE_URL="${SERVICE_URL%/}"

# Two vault ids the service can actually resolve, as "<chainId>:<0x address>".
# Pick them from `curl -s "$SERVICE_URL/v1/catalog"` before recording.
VAULTS="${VAULTS:-<<FILL: two live vault ids, comma separated, e.g. 1:0xabc...,8453:0xdef...>>}"

POLICY="${POLICY:-packages/agent/policy.example.json}"
POLICY_STRICT="${POLICY_STRICT:-packages/agent/policy.strict.json}"

# The receipt hash to look up in step 6. `agent watch` prints this; export it to
# chain the steps together, otherwise step 6 shows the shape of the lookup only.
RECEIPT_HASH="${RECEIPT_HASH:-<<FILL: receipt hash printed by agent watch>>}"

# Filled by scripts/identity.ts (Task 18) and set in the service's environment.
HCS_TOPIC_ID="${HEDERA_HCS_TOPIC_ID:-<<FILL: HCS topic id>>}"

BOLD=$'\033[1m'
DIM=$'\033[2m'
RESET=$'\033[0m'

heading() {
  printf '\n%s========================================================%s\n' "$BOLD" "$RESET"
  printf '%s %s%s\n' "$BOLD" "$*" "$RESET"
  printf '%s========================================================%s\n\n' "$BOLD" "$RESET"
}

note() {
  printf '%s%s%s\n' "$DIM" "$*" "$RESET"
}

# Decodes standard base64 on stdin. GNU coreutils wants --decode, BSD/macOS wants -D,
# so buffer the input and try both rather than losing stdin on the first failure.
b64d() {
  local data
  data="$(cat)"
  printf '%s' "$data" | base64 --decode 2>/dev/null || printf '%s' "$data" | base64 -D
}

# Runs a command if its entrypoint file exists, otherwise prints it and moves on.
run_or_show() {
  local guard="$1"
  shift
  if [ -e "$guard" ]; then
    "$@"
  else
    note "Not built yet: $guard is missing. The command this step runs is:"
    printf '  %s\n' "$*"
  fi
}

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "demo.sh needs $tool on PATH" >&2; exit 1; }
done

heading "0. Service under test"
echo "SERVICE_URL = $SERVICE_URL"
curl -sf "$SERVICE_URL/health" | jq

heading "1. Discovery: the signed agent card"
note "Endpoints, prices, and the two post-quantum key identities the card commits to."
curl -sf "$SERVICE_URL/.well-known/agent.json" | jq '{
  name,
  endpoints,
  prices,
  limits,
  erc8004,
  hcs,
  sig_key: { alg: .pq.sig.alg, pub_hash: .pq.sig.pub_hash },
  kem_key: { alg: .pq.kem.alg, kid: .pq.kem.kid },
  card_signature: { alg: .sig.alg, pub_hash: .sig.pub_hash }
}'
note "Verify: card.sig is ML-DSA-65 over the card without .sig, and pq.sig.pub_hash"
note "matches getMetadata(agentId, \"pq.sig.pubhash\") on the ERC-8004 registry."

heading "2. Unpaid request: the 402 and its decoded price"
note "Three vaults, so the metered price is 0.001 + 0.0005 * 3 = 0.0025 USD."
hdr="$(mktemp)"
status="$(curl -s -o /dev/null -D "$hdr" -w '%{http_code}' \
  -X POST "$SERVICE_URL/hedera/v1/scan" \
  -H 'content-type: application/json' \
  -H 'x-vr-count: 3' \
  -d '{"vaults":[
        "1:0x0000000000000000000000000000000000000001",
        "1:0x0000000000000000000000000000000000000002",
        "8453:0x0000000000000000000000000000000000000003"]}')"
echo "HTTP $status"
if [ "$status" = "402" ]; then
  tr -d '\r' < "$hdr" | awk 'tolower($1) == "payment-required:" { print $2 }' | b64d | jq
else
  note "Expected 402. A 404 here means the Hedera rail is not mounted on this instance."
fi
rm -f "$hdr"

heading "3. Paid scan on Hedera, balanced policy: sealed scan tier"
note "Seals the request, answers the 402 with a signed HTS USDC transfer through"
note "Blocky402, opens the sealed reply, verifies the receipt and every attestation,"
note "applies the policy's own max_age_seconds check, then decides per vault."
run_or_show packages/agent/src/cli.ts \
  bun run agent watch --vaults "$VAULTS" --policy "$POLICY" --service "$SERVICE_URL"

heading "4. Paid request on Hedera, strict policy: table tier"
note "privacy: \"strict\" buys the whole protocol table instead of naming holdings, so"
note "the vendor never learns which vaults are held. Flat 0.03 USD, deliberately more"
note "than a sealed scan."
run_or_show packages/agent/src/cli.ts \
  bun run agent watch --vaults "$VAULTS" --policy "$POLICY_STRICT" --service "$SERVICE_URL"

heading "5. Paid scan on Arc through Circle Gateway"
note "EIP-3009 authorization, bucketed route /arc/v1/scan/s, batched settlement."
run_or_show packages/service/scripts/hello-arc.ts \
  bun run packages/service/scripts/hello-arc.ts

heading "6. Receipt lookup and its HCS commitment"
note "The commitment is the receipt hash and its signature, never the content."
note "sequence stays null until Hedera consensus confirms the message."
curl -sf "$SERVICE_URL/v1/receipts/$RECEIPT_HASH" | jq || \
  note "No receipt under that hash yet. Export RECEIPT_HASH from step 3 and re-run."

heading "7. The public audit trail"
echo "HCS topic:   $HCS_TOPIC_ID"
echo "Mirror node: https://testnet.mirrornode.hedera.com/api/v1/topics/$HCS_TOPIC_ID/messages?limit=25&order=desc"
echo "HashScan:    https://hashscan.io/testnet/topic/$HCS_TOPIC_ID"
note "Dashboard: <<FILL: deployed dashboard URL>>"

heading "Done"
