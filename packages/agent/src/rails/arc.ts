import { GatewayClient, type PayResult } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

export type ArcPayResult<T = unknown> = PayResult<T>;

/** Derives the payer address for an Arc private key without touching the network —
 *  used both to fill in `payer` on a sealed request and, in tests, to compute the
 *  expected payer with no Gateway client involved. */
export function arcAddress(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address;
}

/**
 * Pays a VaultRadar Arc route via Circle's Gateway nanopayment batching (EIP-3009,
 * settled off-chain until the facilitator batches it). Builds a fresh `GatewayClient`
 * per call rather than caching one on the client instance, since a `VaultRadarClient`
 * may never touch the Arc rail at all (Hedera-only usage should never construct a
 * Gateway wallet). Not exercised by the test suite (it talks to Arc testnet).
 */
export async function payArc<T = unknown>(
  privateKey: `0x${string}`,
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<ArcPayResult<T>> {
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
  return gateway.pay<T>(url, { method: "POST", body, headers });
}
