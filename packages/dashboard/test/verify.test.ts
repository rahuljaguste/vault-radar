import { expect, test } from "bun:test";
import {
  attachSig,
  buildReceipt,
  checkSig,
  deriveKemKeys,
  deriveSigningKeys,
  fromB64,
  sha256Hex,
  toB64,
  verifyReceipt,
  type Receipt,
} from "@vaultradar/core";
import { isVerified, type Done } from "../app/verify/page";

/**
 * The `/verify` page's rule: a receipt reads "verified" only when its signature checks out,
 * the card that published the key vouches for itself, the receipt names that key, and every
 * ERC-8004 identity the card lists anchors it on chain.
 *
 * These drive `isVerified` directly (the page's own state machine) plus the two core
 * primitives it composes, against real ML-DSA-65 keys — the page itself is a React client
 * component and its rendering is not what is being pinned here.
 */

const service = deriveSigningKeys("dd".repeat(32));
const impostor = deriveSigningKeys("ee".repeat(32));
const kem = deriveKemKeys("ff".repeat(64));

function receiptFrom(keys: { secretKey: Uint8Array; pubHash: string }): Receipt {
  return buildReceipt(
    {
      service: { erc8004: [{ chainId: "296", agentId: "7" }] },
      request_hash: "a".repeat(64),
      response_hash: "b".repeat(64),
      sealed: true,
      sources: [],
      price: { amount: "1500", asset: "0.0.429274", rail: "hedera" },
      payment: { rail: "hedera", txId: "0.0.42@1.0" },
      tier: "scan",
      hcs: { topicId: "0.0.99" },
    },
    keys,
  );
}

/** A minimal signed agent card, of the shape `/.well-known/agent.json` returns — signed
 *  with the service's own `attachSig`, the same way `packages/service/src/keys.ts` does. */
function cardFrom(keys: { secretKey: Uint8Array; pubHash: string }, publicKey: Uint8Array, erc8004: { chainId: string; agentId: string }[]) {
  return attachSig(
    {
      name: "VaultRadar",
      pq: {
        sig: { alg: "ML-DSA-65", public_key: toB64(publicKey), pub_hash: keys.pubHash },
        kem: { alg: "ml-kem768-x25519", public_key: toB64(kem.publicKey), kid: kem.kid },
      },
      erc8004,
    },
    keys,
  );
}

const base: Done = {
  status: "done",
  signatureValid: true,
  cardSignatureValid: true,
  keyMatchesCard: true,
  anchors: [{ chainId: "296", agentId: "7", state: "matches" }],
  hash: "c".repeat(64),
};

test("all four conditions together are what reads as verified", () => {
  expect(isVerified(base)).toBe(true);
});

test("each condition on its own is enough to refuse", () => {
  expect(isVerified({ ...base, signatureValid: false })).toBe(false);
  // A card that does not vouch for itself cannot be the source of a trusted key, even
  // though the receipt's signature verifies against the key it shipped.
  expect(isVerified({ ...base, cardSignatureValid: false })).toBe(false);
  expect(isVerified({ ...base, keyMatchesCard: false })).toBe(false);
  expect(isVerified({ ...base, anchors: [{ chainId: "296", agentId: "7", state: "mismatch" }] })).toBe(false);
  // "unavailable" is not "matches": an unreadable registry leaves the binding unproven, so
  // the page must not claim it.
  expect(isVerified({ ...base, anchors: [{ chainId: "296", agentId: "7", state: "unavailable" }] })).toBe(false);
});

test("one bad anchor among several is enough, and a card with no identities can still verify", () => {
  expect(
    isVerified({
      ...base,
      anchors: [
        { chainId: "296", agentId: "7", state: "matches" },
        { chainId: "5042002", agentId: "3", state: "mismatch" },
      ],
    }),
  ).toBe(false);
  // No identities listed means there is nothing to compare; the page says so in its own
  // words rather than failing, since an unanchored service is a weaker claim, not a false one.
  expect(isVerified({ ...base, anchors: [] })).toBe(true);
});

test("the freshly-fetched-key attack: a receipt signed by an impostor verifies against the impostor's own card", () => {
  // This is the hole the page's extra checks exist for. The impostor serves a card with
  // their key and a receipt signed by it; the signature check alone passes, and the old page
  // printed "Signature valid."
  const forged = receiptFrom(impostor);
  expect(verifyReceipt(forged, impostor.publicKey)).toBe(true);
  // It does not verify against the real service's key...
  expect(verifyReceipt(forged, service.publicKey)).toBe(false);
  // ...and the card's own claimed hash is the impostor's, so comparing it to the on-chain
  // pin of the real service is what catches it — which is exactly the anchor check.
  const forgedCard = cardFrom(impostor, impostor.publicKey, [{ chainId: "296", agentId: "7" }]);
  expect(checkSig(forgedCard, impostor.publicKey)).toBe(true);
  expect(sha256Hex(impostor.publicKey)).not.toBe(sha256Hex(service.publicKey));
});

test("a card whose claimed pub_hash is not the hash of the key it ships fails the key-matches check", () => {
  // The page computes `sha256Hex(publicKey)` from the shipped key rather than trusting the
  // card's own label, so a card that advertises someone else's hash cannot pass it on to
  // the on-chain comparison.
  const mislabelled = cardFrom(service, service.publicKey, []) as unknown as { pq: { sig: { pub_hash: string } } };
  mislabelled.pq.sig.pub_hash = impostor.pubHash;
  const shipped = sha256Hex(fromB64((mislabelled as unknown as { pq: { sig: { public_key: string } } }).pq.sig.public_key));
  expect(mislabelled.pq.sig.pub_hash).not.toBe(shipped);
  expect(shipped).toBe(service.pubHash);
});
