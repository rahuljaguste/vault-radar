// Exercises the Hedera x402 rail against a *real* Blocky402 facilitator and real
// Hedera testnet accounts — the same flow as scripts/hello-x402.ts, but as assertions.
// Skipped unless LIVE=1, since it needs real credentials this environment doesn't have.
//
// Run once the prerequisites in scripts/hello-x402.ts are met (both accounts
// associated with the USDC token, agent funded with testnet USDC + HBAR):
//
//   LIVE=1 PQ_SIG_SEED=<hex32> PQ_KEM_SEED=<hex64> \
//   HEDERA_PAYTO_ACCOUNT_ID=0.0.x HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=<hex> \
//   HEDERA_FACILITATOR_URL=https://api.testnet.blocky402.com \
//   AGENT_HEDERA_ACCOUNT_ID=0.0.y AGENT_HEDERA_KEY=<ecdsa-hex> \
//   VAULT=1:0x... \
//   bun test packages/service/test/hedera-rail.live.test.ts
import { expect, test } from "bun:test";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { MemoryNonceStore, buildSealedRequest, fromB64, makePgQuery, open, verifyReceipt } from "@vaultradar/core";
import { loadConfig } from "../src/config";
import { loadKeys, buildAgentCard } from "../src/keys";
import { LiveDataProvider } from "../src/data/provider";
import { buildApp } from "../src/app";

test.skipIf(process.env.LIVE !== "1")("hello-x402 flow: a real Hedera testnet payment settles and returns a verified receipt", async () => {
  const config = loadConfig();
  const keys = loadKeys(config);
  const data = new LiveDataProvider(config, { sql: config.databaseUrl ? makePgQuery(config.databaseUrl) : null });
  const app = await buildApp({ config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: { hedera: true } });
  const srv = app.listen(0);
  try {
    const port = (srv.address() as any).port;
    const base = `http://127.0.0.1:${port}`;
    const card = buildAgentCard(config, keys);

    const accountId = process.env.AGENT_HEDERA_ACCOUNT_ID!;
    const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(process.env.AGENT_HEDERA_KEY!), { network: "testnet" });
    const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
    const payFetch = wrapFetchWithPayment(fetch, client);

    const { sealed, replySecret } = buildSealedRequest(
      { vaults: [process.env.VAULT ?? "1:0x0000000000000000000000000000000000000000"] },
      accountId,
      fromB64(card.pq.kem.public_key),
    );

    const res = await payFetch(`${base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1" },
      body: JSON.stringify(sealed),
    });
    expect(res.status).toBe(200);

    const j = await res.json();
    expect(verifyReceipt(j.receipt, fromB64(card.pq.sig.public_key))).toBe(true);
    expect(typeof j.receipt.payment.txId).toBe("string");
    expect(j.receipt.payment.txId.length).toBeGreaterThan(0);

    const opened = open<{ vaults: unknown[] }>(j.sealed, replySecret);
    expect(Array.isArray(opened.vaults)).toBe(true);
  } finally {
    srv.close();
  }
});
