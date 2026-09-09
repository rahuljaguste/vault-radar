import { expect, test } from "bun:test";
import { deriveSigningKeys } from "../src/pq/keys";
import { buildAttestation, buildReceipt, receiptHash, requestHash, responseHash, verifyAttestation, verifyReceipt } from "../src/receipts";

const keys = deriveSigningKeys("66".repeat(32));
const base = {
  service: { erc8004: [{ chainId: "296", agentId: "7" }] },
  request_hash: requestHash({ vaults: ["1:0xabc"] }),
  response_hash: responseHash({ vaults: [], reports: [], attestations: [] }),
  sealed: true, sources: [{ ref: "Qm123", chainId: "1", block: "100", timestamp: "1760000000" }],
  price: { amount: "1500", asset: "0.0.429274", rail: "hedera" as const },
  payment: { rail: "hedera" as const, txId: "0.0.5@1760000000.000000001" },
  tier: "scan" as const, hcs: { topicId: "0.0.99" },
};
test("receipt signs, verifies, hashes without sig", () => {
  const r = buildReceipt(base, keys);
  expect(verifyReceipt(r, keys.publicKey)).toBe(true);
  expect(r.nonce).toMatch(/^[0-9a-f]{32}$/);
  const h1 = receiptHash(r);
  expect(h1).toBe(receiptHash({ ...r, sig: { ...r.sig, value: "AAAA" } }));
  expect(verifyReceipt({ ...r, tier: "table" }, keys.publicKey)).toBe(false);
});
test("attestation signs and verifies", () => {
  const a = buildAttestation({ vaultId: "1:0xabc", chainId: "1", block: "100", timestamp: "1760000000", sharePrice: "1.0213", tvlUsd: null, source: "substreams:erc4626-vault-metrics" }, keys);
  expect(verifyAttestation(a, keys.publicKey)).toBe(true);
  expect(verifyAttestation({ ...a, sharePrice: "9" }, keys.publicKey)).toBe(false);
});
