// hello-x402.ts — pays for one sealed scan against a running VaultRadar service over
// the Hedera x402 rail, end to end: fetches the signed agent card, builds a sealed
// scan request, lets @x402/fetch answer the 402 with a signed Hedera transfer, then
// verifies the returned receipt and opens the sealed reply.
//
// Prerequisites (spec §12):
//   - Both the agent account (AGENT_HEDERA_ACCOUNT_ID) and the service's payTo account
//     must be associated with the USDC token the service prices in (0.0.429274 on
//     testnet) — via TokenAssociateTransaction or the Hedera portal.
//   - The agent account holds testnet USDC (faucet.circle.com) and testnet HBAR for
//     its own signature (the facilitator pays the network fee as fee payer).
//   - The service is running with real HEDERA_* config pointed at a live facilitator.
//
// Run:
//   SERVICE_URL=http://localhost:8787 \
//   AGENT_HEDERA_ACCOUNT_ID=0.0.x AGENT_HEDERA_KEY=<ecdsa-hex> \
//   VAULT=1:0x... \
//   bun run packages/service/scripts/hello-x402.ts
//
// Expected: `status 200`, a `payment-response` decoding to a Hedera transaction id,
// `receipt ok: true`. Then look up that transaction id on HashScan testnet and confirm
// the USDC transfer; paste the HashScan URL into docs/verification-log.md.
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { buildSealedRequest, fromB64, open, verifyReceipt } from "@vaultradar/core";

const base = process.env.SERVICE_URL ?? "http://localhost:8787";
const accountId = process.env.AGENT_HEDERA_ACCOUNT_ID;
const privateKey = process.env.AGENT_HEDERA_KEY;
if (!accountId || !privateKey) {
  console.error("AGENT_HEDERA_ACCOUNT_ID and AGENT_HEDERA_KEY are required");
  process.exit(1);
}

const card = await (await fetch(`${base}/.well-known/agent.json`)).json();

const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: "testnet" });
const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);

const { sealed, replySecret } = buildSealedRequest(
  { vaults: [process.env.VAULT ?? "1:0x0000000000000000000000000000000000000000"] },
  accountId,
  fromB64(card.pq.kem.public_key),
);

const res = await payFetch(card.endpoints.hedera.scan, {
  method: "POST",
  headers: { "content-type": "application/json", "x-vr-count": "1" },
  body: JSON.stringify(sealed),
});

const paymentResponseHeader = res.headers.get("payment-response");
console.log("status", res.status, "payment-response", paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : null);

const j = await res.json();
if (res.status !== 200) {
  console.log(j);
  process.exit(1);
}

console.log("receipt ok:", verifyReceipt(j.receipt, fromB64(card.pq.sig.public_key)), "receipt txId:", j.receipt.payment.txId);
console.log("opened:", JSON.stringify(open(j.sealed, replySecret)).slice(0, 300));
