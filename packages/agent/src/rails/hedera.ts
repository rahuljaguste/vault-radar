import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";

/**
 * Wraps `fetch` so a 402 from VaultRadar's Hedera routes is paid automatically: the
 * x402 client signs and attaches a Hedera `exact` payment (an HTS USDC transfer naming
 * the Blocky402 facilitator as fee payer) and retries once. Not exercised by the test
 * suite (it talks to Hedera testnet), so `VaultRadarClient` accepts a `payingFetch`
 * override that tests use to bypass this entirely.
 */
export function payingFetchHedera(accountId: string, privateKey: string) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: "testnet" } as any);
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
  // Deliberately untyped as `typeof fetch`: bun's ambient `fetch` type additionally
  // requires a static `preconnect` method that the wrapped function doesn't have.
  // `wrapFetchWithPayment`'s own declared return type is exactly the callable shape
  // `VaultRadarClient` needs, so let it flow through unannotated.
  return wrapFetchWithPayment(fetch, client);
}

/**
 * Pulls the settled Hedera transaction id out of the `PAYMENT-RESPONSE` header the
 * service sets on a successful (200) response. Returns null rather than throwing when
 * the header is absent or malformed, since a missing tx id should surface as "unknown
 * payment reference" to the caller, not crash the scan/table call that already
 * succeeded.
 */
export function txIdFromResponse(res: Response): string | null {
  const header = res.headers.get("payment-response");
  if (!header) return null;
  try {
    return (decodePaymentResponseHeader(header) as { transaction?: string }).transaction ?? null;
  } catch {
    return null;
  }
}
