// hello-x402.ts — pays for one sealed scan against a running VaultRadar service over
// the Hedera x402 rail, end to end: fetches the signed agent card and verifies its
// self-signature, builds a sealed scan request, lets @x402/fetch answer the 402 with a
// signed Hedera transfer, then verifies the returned receipt and opens the sealed reply.
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
import { buildSealedRequest, checkSig, fromB64, open, verifyReceipt } from "@vaultradar/core";

const base = process.env.SERVICE_URL ?? "http://localhost:8787";
const accountId = process.env.AGENT_HEDERA_ACCOUNT_ID;
const privateKey = process.env.AGENT_HEDERA_KEY;
if (!accountId || !privateKey) {
  console.error("AGENT_HEDERA_ACCOUNT_ID and AGENT_HEDERA_KEY are required");
  process.exit(1);
}

const card = await (await fetch(`${base}/.well-known/agent.json`)).json();

// The card proves nothing on its own: anyone answering for this URL can publish a card
// with their own key. It has to verify under the very key it ships — the same
// self-signature check the agent client runs (`VaultRadarClient.discover`) before it
// pays anything. Without it, "receipt ok: true" below would only show that the receipt
// and the card came from the same place, not that either is VaultRadar.
const sigPk = fromB64(card.pq.sig.public_key);
if (!checkSig(card, sigPk)) {
  console.error("agent card signature did not verify, refusing to pay this service");
  process.exit(1);
}

// network must be CAIP-2 ("hedera:testnet"), not the bare "testnet" — Task 22+23's
// agent hit this first (task-19-27-report.md carries the fix forward); a bare network
// id here fails signer construction against @x402/hedera 2.25.0.
const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: "hedera:testnet" });
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

console.log("receipt ok:", verifyReceipt(j.receipt, sigPk), "receipt txId:", j.receipt.payment.txId);
console.log("opened:", JSON.stringify(open(j.sealed, replySecret)).slice(0, 300));
