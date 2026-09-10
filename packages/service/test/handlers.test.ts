import { expect, test } from "bun:test";
import express from "express";
import {
  buildSealedRequest,
  deriveKemKeys,
  deriveSigningKeys,
  MemoryNonceStore,
  open,
  verifyReceipt,
  verifyAttestation,
  requestHash,
  hederaScanPriceAtomic,
  ARC_BUCKET_PRICE,
  TABLE_PRICE_USD,
} from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../src/handlers/scan";
import { loadConfig } from "../src/config";

const env = {
  PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64),
  GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.99",
};
const config = loadConfig(env);
const keys = { sig: deriveSigningKeys(env.PQ_SIG_SEED), kem: deriveKemKeys(env.PQ_KEM_SEED) };
const now = Math.floor(Date.now() / 1000);

const vault = {
  id: "1:0xabababababababababababababababababababab", kind: "erc4626", protocol: "erc4626", chain: "ethereum", chainId: "1",
  asset: null, sharePrice: "1.01", tvlUsd: null, inputTokenBalance: "100", depositLimit: null,
  history: [],
  sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "10", timestamp: String(now - 5), ageSeconds: "5", freshness: "fresh" }],
  freshness: "fresh",
} as const;

// A fresh stub DataProvider per mount() call — makeScanHandler never mutates it, but
// each test wants to control scan/table/catalog behavior (and sometimes make them fail
// or hang) independently of every other test.
function makeData(overrides: { scan?: any; table?: any; catalog?: any } = {}) {
  return {
    catalog: overrides.catalog ?? (async () => ({ protocols: [], erc4626Chains: ["1"] })),
    scan: overrides.scan ?? (async (ids: string[]) => ({
      vaults: ids.includes("1:0xabababababababababababababababababababab") ? [vault] : [],
      sources: [{ ref: "erc4626-vault-metrics", chainId: "1", block: "10", timestamp: String(now - 5) }],
    })),
    table: overrides.table ?? (async () => ({ vaults: [vault], sources: [] })),
  };
}

// Mounts a fresh app + server per test so different tier/rail/data/capMs combinations
// (and their nonce stores) never interact across tests.
function mount(overrides: Partial<HandlerDeps> & { data: any }) {
  const app = express();
  app.use(express.json());
  const deps: HandlerDeps = {
    keys, config, nonces: new MemoryNonceStore(), rail: "hedera", tier: "scan",
    getPayer: () => "0.0.1234", getTxId: () => "0.0.1234@1.000",
    ...overrides,
  };
  app.post("/scan", makeScanHandler(deps));
  const srv = app.listen(0);
  const url = () => `http://127.0.0.1:${(srv.address() as any).port}/scan`;
  return { url, srv };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("sealed scan returns sealed body and a receipt with every required field", async () => {
  const { url, srv } = mount({ data: makeData() });
  try {
    const { sealed, replySecret } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0.0.1234", keys.kem.publicKey);
    const res = await post(url(), sealed, { "x-vr-count": "1" });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.sealed).toBeDefined();
    expect(verifyReceipt(j.receipt, keys.sig.publicKey)).toBe(true);
    expect(j.receipt.request_hash).toBe(requestHash({ vaults: ["1:0xabababababababababababababababababababab"] }));
    expect(j.receipt.sealed).toBe(true);
    expect(j.receipt.tier).toBe("scan");
    expect(j.receipt.price).toEqual({ amount: hederaScanPriceAtomic(1), asset: config.hedera.usdcToken, rail: "hedera" });
    expect(j.receipt.payment).toEqual({ rail: "hedera", txId: "0.0.1234@1.000" });
    expect(j.receipt.sources).toEqual([{ ref: "erc4626-vault-metrics", chainId: "1", block: "10", timestamp: String(now - 5) }]);
    expect(j.receipt.hcs).toEqual({ topicId: "0.0.99" });

    const body = open<any>(j.sealed, replySecret);
    expect(body.vaults[0].id).toBe("1:0xabababababababababababababababababababab");
    expect(body.reports[0].verdict).toBe("ok");
    expect(verifyAttestation(body.attestations[0], keys.sig.publicKey)).toBe(true);
  } finally {
    srv.close();
  }
});

test("payer mismatch on a sealed request returns 422 payer_mismatch", async () => {
  const { url, srv } = mount({ data: makeData() });
  try {
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0.0.9999", keys.kem.publicKey);
    const res = await post(url(), sealed, { "x-vr-count": "1" });
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("payer_mismatch");
  } finally {
    srv.close();
  }
});

test("clear request works and the receipt says sealed:false", async () => {
  const { url, srv } = mount({ data: makeData() });
  try {
    const res = await post(url(), { vaults: ["1:0xabababababababababababababababababababab"] }, { "x-vr-count": "1" });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.vaults[0].id).toBe("1:0xabababababababababababababababababababab");
    expect(j.receipt.sealed).toBe(false);
    expect(j.sealed).toBeUndefined();
  } finally {
    srv.close();
  }
});

test("a corrupted sealed envelope returns 422 envelope_open_failed", async () => {
  const { url, srv } = mount({ data: makeData() });
  try {
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0.0.1234", keys.kem.publicKey);
    // Same length, guaranteed-different nonce: the GCM tag no longer verifies, so
    // open() throws regardless of what the ciphertext/body bytes happen to be.
    const tampered = { ...sealed, nonce: "A".repeat(sealed.nonce.length) };
    const res = await post(url(), tampered);
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("envelope_open_failed");
  } finally {
    srv.close();
  }
});

test("a sealed request whose payer the rail cannot identify returns 422 payer_unknown", async () => {
  const { url, srv } = mount({ data: makeData(), getPayer: () => null });
  try {
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0.0.1234", keys.kem.publicKey);
    const res = await post(url(), sealed);
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("payer_unknown");
  } finally {
    srv.close();
  }
});

test("malformed, empty, or oversized vault lists return 422 bad_vaults", async () => {
  const { url, srv } = mount({ data: makeData() });
  try {
    const tooMany = Array.from({ length: 101 }, (_, i) => `1:0x${i.toString(16).padStart(40, "0")}`);
    for (const body of [{ vaults: [] }, { vaults: ["not-a-vault-id"] }, { vaults: tooMany }]) {
      const res = await post(url(), body);
      expect(res.status).toBe(422);
      expect((await res.json()).reason).toBe("bad_vaults");
    }
  } finally {
    srv.close();
  }
});

test("a table request missing protocol or chainId returns 422 bad_table_request", async () => {
  const { url, srv } = mount({ data: makeData(), tier: "table" });
  try {
    const res = await post(url(), { protocol: "aave-v3" });
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("bad_table_request");
  } finally {
    srv.close();
  }
});

test("table tier on the arc rail prices flat at TABLE_PRICE_USD and returns the provider's vaults", async () => {
  const { url, srv } = mount({ data: makeData(), tier: "table", rail: "arc" });
  try {
    const res = await post(url(), { protocol: "erc4626", chainId: "1" });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.vaults[0].id).toBe("1:0xabababababababababababababababababababab");
    expect(j.receipt.tier).toBe("table");
    expect(j.receipt.price).toEqual({ amount: TABLE_PRICE_USD, asset: "USDC", rail: "arc" });
  } finally {
    srv.close();
  }
});

test("scan tier on the arc rail prices by count bucket", async () => {
  const { url, srv } = mount({ data: makeData(), rail: "arc" });
  try {
    const res = await post(url(), { vaults: ["1:0xabababababababababababababababababababab"] });
    const j = await res.json();
    expect(j.receipt.price).toEqual({ amount: ARC_BUCKET_PRICE.s, asset: "USDC", rail: "arc" });
  } finally {
    srv.close();
  }
});

test("an upstream provider failure returns 502 upstream_failed and logs only the error message", async () => {
  const { url, srv } = mount({ data: makeData({ scan: async () => { throw new Error("subgraph boom"); } }) });
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const res = await post(url(), { vaults: ["1:0xabababababababababababababababababababab"] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ reason: "upstream_failed" });
  } finally {
    console.error = originalError;
    srv.close();
  }
  expect(logged.length).toBe(1);
  expect(String(logged[0])).toContain("subgraph boom");
});

test("a handler that exceeds its time cap returns 504 handler_cap", async () => {
  const { url, srv } = mount({ data: makeData({ scan: () => new Promise(() => {}) }), capMs: 20 });
  try {
    const res = await post(url(), { vaults: ["1:0xabababababababababababababababababababab"] });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ reason: "handler_cap" });
  } finally {
    srv.close();
  }
});
