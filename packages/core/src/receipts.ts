import { hashJson } from "./canonical";
import { Sig, attachSig, checkSig } from "./pq/sign";
import { randomBytes, toHex } from "./util/bytes";

export type Rail = "hedera" | "arc";
export type SourceRef = { ref: string; chainId: string; block: string; timestamp: string };
export type Receipt = {
  v: 1; service: { erc8004: { chainId: string; agentId: string }[] };
  request_hash: string; response_hash: string; sealed: boolean; sources: SourceRef[];
  price: { amount: string; asset: string; rail: Rail }; payment: { rail: Rail; txId: string };
  tier: "scan" | "table"; issued_at: string; nonce: string; hcs: { topicId: string }; sig: Sig;
};
export type Attestation = { v: 1; vaultId: string; chainId: string; block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; source: string; sig: Sig };
type Keys = { secretKey: Uint8Array; pubHash: string };

export const requestHash = (request: unknown) => hashJson(request);
export const responseHash = (body: { vaults: unknown; reports: unknown; attestations: unknown }) =>
  hashJson({ vaults: body.vaults, reports: body.reports, attestations: body.attestations });
export function buildReceipt(input: Omit<Receipt, "v" | "sig" | "nonce" | "issued_at"> & { issued_at?: string }, keys: Keys): Receipt {
  const body = { v: 1 as const, ...input, issued_at: input.issued_at ?? String(Math.floor(Date.now() / 1000)), nonce: toHex(randomBytes(16)) };
  return attachSig(body, keys);
}
export const receiptHash = (r: Receipt) => { const { sig: _s, ...rest } = r; return hashJson(rest); };
export const verifyReceipt = (r: Receipt, pk: Uint8Array) => checkSig(r, pk);
export const buildAttestation = (a: Omit<Attestation, "v" | "sig">, keys: Keys): Attestation => attachSig({ v: 1 as const, ...a }, keys);
export const verifyAttestation = (a: Attestation, pk: Uint8Array) => checkSig(a, pk);
