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
import { headline, isVerified, type Done } from "../app/verify/page";

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
  identitiesInCard: true,
  anchors: [{ chainId: "296", agentId: "7", state: "matches" }],
  hash: "c".repeat(64),
};

test("all five conditions together are what reads as verified", () => {
  expect(isVerified(base)).toBe(true);
  expect(headline(base)).toBe("Verified.");
});

test("each condition on its own is enough to refuse, and the headline names which", () => {
  expect(isVerified({ ...base, signatureValid: false })).toBe(false);
  expect(headline({ ...base, signatureValid: false })).toContain("signature is INVALID");
  // A card that does not vouch for itself cannot be the source of a trusted key, even
  // though the receipt's signature verifies against the key it shipped.
  expect(isVerified({ ...base, cardSignatureValid: false })).toBe(false);
  expect(headline({ ...base, cardSignatureValid: false })).toContain("card does not carry a valid signature");
  expect(isVerified({ ...base, keyMatchesCard: false })).toBe(false);
  expect(headline({ ...base, keyMatchesCard: false })).toContain("not the published one");
  expect(isVerified({ ...base, identitiesInCard: false })).toBe(false);
  expect(headline({ ...base, identitiesInCard: false })).toContain("card does not claim");
  expect(isVerified({ ...base, anchors: [{ chainId: "296", agentId: "7", state: "mismatch" }] })).toBe(false);
  expect(headline({ ...base, anchors: [{ chainId: "296", agentId: "7", state: "mismatch" }] })).toContain("pins a different key");
  // "unavailable" is not "matches": an unreadable registry leaves the binding unproven, so
  // the page must not claim it.
  const unavailable = { ...base, anchors: [{ chainId: "296", agentId: "7", state: "unavailable" as const }] };
  expect(isVerified(unavailable)).toBe(false);
  expect(headline(unavailable)).toContain("UNPROVEN");
});

test("a receipt that claims no on-chain identity is UNPROVEN, never Verified", () => {
  // The hole: the identities used to come from the live agent card, which is served by
  // whoever is answering for the service URL — so an impostor could ship a card with an
  // empty `erc8004`, skip the on-chain check entirely, and the page printed "Verified."
  // They now come from the receipt's signed `service.erc8004`, and an empty list is a
  // receipt with nothing anchoring its key.
  const unanchored = { ...base, anchors: [] };
  expect(isVerified(unanchored)).toBe(false);
  expect(headline(unanchored)).toContain("UNPROVEN");
  expect(headline(unanchored)).toContain("claims no on-chain identity");
  expect(headline(unanchored)).not.toContain("Verified.");
});

test("one bad anchor among several is enough", () => {
  expect(
    isVerified({
      ...base,
      anchors: [
        { chainId: "296", agentId: "7", state: "matches" },
        { chainId: "5042002", agentId: "3", state: "mismatch" },
      ],
    }),
  ).toBe(false);
  // Every identity the receipt names has to anchor, not just one of them.
  expect(
    isVerified({
      ...base,
      anchors: [
        { chainId: "296", agentId: "7", state: "matches" },
        { chainId: "5042002", agentId: "3", state: "unavailable" },
      ],
    }),
  ).toBe(false);
});

test("the identities checked are the receipt's signed ones, which a card cannot shrink", () => {
  // A receipt signed by the real service names its identities inside the signed body, so
  // `checkSig` covers them: an impostor cannot remove them without breaking the signature,
  // and cannot add one without the card agreeing (the cross-check below).
  const receipt = receiptFrom(service);
  expect(checkSig(receipt, service.publicKey)).toBe(true);
  expect(receipt.service.erc8004).toEqual([{ chainId: "296", agentId: "7" }]);

  // Tampering with the signed list breaks the signature, which is the point.
  const stripped = { ...receipt, service: { erc8004: [] } };
  expect(checkSig(stripped, service.publicKey)).toBe(false);

  // A card that lists the identity satisfies the cross-check; one that does not, fails it.
  const card = cardFrom(service, service.publicKey, [{ chainId: "296", agentId: "7" }]) as unknown as {
    erc8004: { chainId: string; agentId: string }[];
  };
  const inCard = (claimed: { chainId: string; agentId: string }[], onCard: { chainId: string; agentId: string }[]) =>
    claimed.every((c) => onCard.some((o) => o.chainId === c.chainId && o.agentId === c.agentId));
  expect(inCard(receipt.service.erc8004, card.erc8004)).toBe(true);
  expect(inCard(receipt.service.erc8004, [])).toBe(false);
  expect(inCard(receipt.service.erc8004, [{ chainId: "296", agentId: "8" }])).toBe(false);
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
