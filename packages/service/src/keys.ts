import { deriveKemKeys, deriveSigningKeys, attachSig, toB64, hederaScanPriceUsd, ARC_BUCKET_PRICE, TABLE_PRICE_USD } from "@vaultradar/core";
import type { Config } from "./config";

export type ServiceKeys = { sig: ReturnType<typeof deriveSigningKeys>; kem: ReturnType<typeof deriveKemKeys> };

export const loadKeys = (c: Config): ServiceKeys => ({ sig: deriveSigningKeys(c.sigSeed), kem: deriveKemKeys(c.kemSeed) });

export function buildAgentCard(c: Config, k: ServiceKeys) {
  const u = c.publicUrl.replace(/\/$/, "");
  const card = {
    name: "VaultRadar", version: "0.1.0", description: "Cross-protocol vault risk, metered over x402, sealed with PQ KEM, receipts signed with ML-DSA-65.",
    pq: { sig: { alg: "ML-DSA-65", public_key: toB64(k.sig.publicKey), pub_hash: k.sig.pubHash }, kem: { alg: "ml-kem768-x25519", public_key: toB64(k.kem.publicKey), kid: k.kem.kid } },
    erc8004: c.erc8004, hcs: { topicId: c.hedera.hcsTopicId },
    endpoints: { hedera: { scan: `${u}/hedera/v1/scan`, scanHbar: `${u}/hedera/v1/scan-hbar`, table: `${u}/hedera/v1/table`, network: "hedera:testnet", asset: c.hedera.usdcToken },
                 arc: { scan: { s: `${u}/arc/v1/scan/s`, m: `${u}/arc/v1/scan/m`, l: `${u}/arc/v1/scan/l` }, table: `${u}/arc/v1/table`, network: c.arc.network } },
    prices: { hedera_scan: "0.001 + 0.0005 * count USD", hedera_scan_examples: { "1": hederaScanPriceUsd(1), "10": hederaScanPriceUsd(10) }, arc_scan_buckets: ARC_BUCKET_PRICE, table: TABLE_PRICE_USD },
    limits: { max_vaults: 100, ts_window_seconds: 120 }, docs: `${u}/skill.md`,
  };
  return attachSig(card, k.sig);
}
