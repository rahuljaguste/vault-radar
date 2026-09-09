import { sha256 } from "@noble/hashes/sha2";
import { toHex, utf8 } from "./util/bytes";

function enc(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("canonical JSON: non-integer number; use a decimal string");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return "[" + v.map(x => enc(x === undefined ? null : x)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + enc(o[k])).join(",") + "}";
  }
  throw new Error(`canonical JSON: unsupported type ${typeof v}`);
}
export const canonicalize = (v: unknown): string => enc(v);
export const canonicalBytes = (v: unknown): Uint8Array => utf8(canonicalize(v));
export const sha256Hex = (b: Uint8Array): string => toHex(sha256(b));
export const hashJson = (v: unknown): string => sha256Hex(canonicalBytes(v));
