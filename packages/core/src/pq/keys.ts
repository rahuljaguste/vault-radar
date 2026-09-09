import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { fromHex, utf8 } from "../util/bytes";
import { sha256Hex } from "../canonical";

export const SIG_ALG = "ML-DSA-65" as const;
export const KEM_ALG = "ml-kem768-x25519" as const;

export const kidOf = (publicKey: Uint8Array) => sha256Hex(publicKey).slice(0, 16);

export function deriveSigningKeys(seedHex: string) {
  const seed = fromHex(seedHex);
  if (seed.length !== 32) throw new Error("PQ_SIG_SEED must be 32 bytes hex");
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey, secretKey, pubHash: sha256Hex(publicKey) };
}

export function deriveKemKeys(seedHex: string) {
  const master = fromHex(seedHex);
  if (master.length < 32) throw new Error("PQ_KEM_SEED must be at least 32 bytes hex");
  const need = ml_kem768_x25519.lengths.seed ?? 96;
  const seed = hkdf(sha256, master, undefined, utf8("vaultradar/kem/v1"), need);
  const { publicKey, secretKey } = ml_kem768_x25519.keygen(seed);
  return { publicKey, secretKey, kid: kidOf(publicKey) };
}
