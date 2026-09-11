import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalBytes, sha256Hex } from "../canonical";
import { fromB64, toB64 } from "../util/bytes";
import { SIG_ALG } from "./keys";

export type Sig = { alg: typeof SIG_ALG; pub_hash: string; value: string };
export const signJson = (value: unknown, secretKey: Uint8Array): string =>
  toB64(ml_dsa65.sign(canonicalBytes(value), secretKey));
export const verifyJson = (value: unknown, sigB64: string, publicKey: Uint8Array): boolean => {
  try { return ml_dsa65.verify(fromB64(sigB64), canonicalBytes(value), publicKey); } catch { return false; }
};
export function attachSig<T extends object>(obj: T, keys: { secretKey: Uint8Array; pubHash: string }): T & { sig: Sig } {
  const { sig: _drop, ...body } = obj as T & { sig?: Sig };
  return { ...(body as T), sig: { alg: SIG_ALG, pub_hash: keys.pubHash, value: signJson(body, keys.secretKey) } };
}
/**
 * Verifies `obj.sig` over the canonical bytes of `obj` without its `sig` field, and
 * requires `sig.pub_hash` to be the SHA-256 of the very `publicKey` the signature was
 * checked against.
 *
 * The hash binding is not redundant with the signature check. `pub_hash` is the field
 * every consumer of a signed object compares against an *independent* pin of the
 * service's identity — the `pq.sig.pub_hash` on the agent card, and
 * `getMetadata(agentId, "pq.sig.pubhash")` on the ERC-8004 registry (spec §5.4). Before
 * this check, `pub_hash` was a free-text field nothing verified: a service could sign
 * with key A and label the signature with the hash of key B, and every caller that
 * verified the signature against A while comparing `pub_hash` to an on-chain pin of B
 * would report both "signature valid" and "key binding matches" for a receipt that was
 * never signed by the pinned key. Recomputing the hash here makes the two facts one
 * fact, so the on-chain comparison a caller performs is a comparison about the key that
 * actually produced this signature.
 *
 * Returns false rather than throwing on any malformed input, same as before.
 */
export function checkSig<T extends { sig?: Sig }>(obj: T | null | undefined, publicKey: Uint8Array): boolean {
  if (!obj || typeof obj !== "object" || !obj.sig || obj.sig.alg !== SIG_ALG) return false;
  const { sig, ...body } = obj;
  if (typeof sig.pub_hash !== "string" || sig.pub_hash !== sha256Hex(publicKey)) return false;
  return verifyJson(body, sig.value, publicKey);
}
