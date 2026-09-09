import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { canonicalBytes } from "../canonical";
import { fromB64, fromUtf8, randomBytes, toB64, utf8 } from "../util/bytes";
import { KEM_ALG, kidOf } from "./keys";

export type Sealed = { v: 1; kem: typeof KEM_ALG; kid: string; ct: string; nonce: string; body: string };
const INFO = utf8("vaultradar/seal/v1");
const deriveAead = (ss: Uint8Array) => hkdf(sha256, ss, undefined, INFO, 32);

export function seal(plain: unknown, recipientPk: Uint8Array): Sealed {
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(recipientPk);
  const nonce = randomBytes(12);
  const body = gcm(deriveAead(sharedSecret), nonce).encrypt(canonicalBytes(plain));
  return { v: 1, kem: KEM_ALG, kid: kidOf(recipientPk), ct: toB64(cipherText), nonce: toB64(nonce), body: toB64(body) };
}
export function open<T = unknown>(s: Sealed, secretKey: Uint8Array, expectKid?: string): T {
  if (s.v !== 1 || s.kem !== KEM_ALG) throw new Error("unsupported envelope");
  if (expectKid && s.kid !== expectKid) throw new Error("kid mismatch");
  const ss = ml_kem768_x25519.decapsulate(fromB64(s.ct), secretKey);
  const plain = gcm(deriveAead(ss), fromB64(s.nonce)).decrypt(fromB64(s.body));
  return JSON.parse(fromUtf8(plain)) as T;
}
export function isSealed(x: unknown): x is Sealed {
  const s = x as Sealed;
  return !!s && s.v === 1 && s.kem === KEM_ALG && typeof s.ct === "string" && typeof s.nonce === "string" && typeof s.body === "string" && typeof s.kid === "string";
}
