// hello-arc.ts — pays for one sealed scan against a running VaultRadar service over the
// Arc x402 rail, end to end: fetches the signed agent card and verifies its
// self-signature, optionally deposits USDC into Circle Gateway, builds a sealed scan
// request, lets `GatewayClient.pay` answer the 402 with a signed EIP-3009 authorization,
// then verifies the returned receipt and opens the sealed reply.
//
// Prerequisites:
//   - An Arc testnet EVM account (AGENT_ARC_KEY) holding testnet USDC (faucet.circle.com
//     on Arc testnet — Arc gas is USDC too, but Gateway-batched payments are gasless for
//     the payer: the facilitator settles the batch on-chain).
//   - That account has a Gateway balance on Arc testnet — either from a previous
//     `DEPOSIT=` run of this script, or deposited separately. `gw.deposit(amount)` sends
//     a real on-chain approve + deposit, so it needs testnet USDC and a little testnet
//     ETH-equivalent gas up front; once deposited, `gw.pay` itself is gasless.
//   - The service is running with real ARC_* config pointed at a live Gateway
//     facilitator (defaults to https://gateway-api-testnet.circle.com).
//
// Run:
//   SERVICE_URL=http://localhost:8787 \
//   AGENT_ARC_KEY=0x... \
//   VAULT=1:0x... \
//   [DEPOSIT=2] \
//   bun run packages/service/scripts/hello-arc.ts
//
// Expected: (if DEPOSIT is set) a deposit result logged first, then `paid 0.003`, a
// transaction hash resolvable on https://testnet.arcscan.app, `receipt ok: true`. Paste
// the arcscan URL into docs/verification-log.md.
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { buildSealedRequest, checkSig, fromB64, open, verifyReceipt } from "@vaultradar/core";

const base = process.env.SERVICE_URL ?? "http://localhost:8787";
const privateKey = process.env.AGENT_ARC_KEY;
if (!privateKey) {
  console.error("AGENT_ARC_KEY is required (0x-prefixed EVM private key)");
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
  console.error("agent card signature did not verify — refusing to pay this service");
  process.exit(1);
}

const gw = new GatewayClient({ chain: "arcTestnet", privateKey: privateKey as `0x${string}` });

if (process.env.DEPOSIT) {
  console.log("depositing", process.env.DEPOSIT, "USDC into Gateway...");
  console.log(await gw.deposit(process.env.DEPOSIT));
}

const { sealed, replySecret } = buildSealedRequest(
  { vaults: [process.env.VAULT ?? "1:0x0000000000000000000000000000000000000000"] },
  gw.account.address,
  fromB64(card.pq.kem.public_key),
);

const res = await gw.pay<{ receipt: unknown; sealed: unknown }>(card.endpoints.arc.scan.s, {
  method: "POST",
  body: sealed,
  headers: { "x-vr-count": "1" },
});

console.log("paid", res.formattedAmount, "tx", res.transaction, "status", res.status);
console.log("payer", gw.account.address);
console.log("receipt ok:", verifyReceipt(res.data.receipt as any, sigPk));
console.log("opened:", JSON.stringify(open(res.data.sealed as any, replySecret)).slice(0, 300));
