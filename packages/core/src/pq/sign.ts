import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalBytes } from "../canonical";
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
export function checkSig<T extends { sig?: Sig }>(obj: T, publicKey: Uint8Array): boolean {
  if (!obj.sig || obj.sig.alg !== SIG_ALG) return false;
  const { sig, ...body } = obj;
  return verifyJson(body, sig.value, publicKey);
}
