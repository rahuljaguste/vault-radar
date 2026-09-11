import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { PaymentPolicy } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { overQuoteReason, type QuoteSource } from "./quote";

export { QUOTE_TOLERANCE_BPS, maxAcceptableAtomic, overQuoteReason, type QuoteSource } from "./quote";

/**
 * CAIP-2 identifier for Hedera testnet. `@x402/hedera` validates its `network` option
 * against exactly `"hedera:mainnet"` / `"hedera:testnet"` and throws
 * `Unsupported Hedera network: <value>` for anything else — including the bare
 * `"testnet"` this used to pass, which made every real (non-test) Hedera payment fail
 * at signer construction. It is also the key the scheme registers under, so the two
 * cannot drift apart.
 */
export const HEDERA_TESTNET_CAIP2 = "hedera:testnet";

/**
 * A payment policy (see `@x402/core/client`'s `PaymentPolicy`) that refuses to sign for
 * more than the agent quoted itself.
 *
 * Without it the agent paid whatever the 402 demanded: `x402Client` hands the server's
 * `accepts[]` straight to the scheme, which signs a transfer for `requirements.amount`.
 * The only ceiling was @x402/core's own default `$1`-per-payment spend control, which it
 * applies ahead of policies — so a service that answered a one-vault scan (quoted
 * $0.0015) with a 402 for ninety cents was paid ninety cents, six hundred times the
 * price, with nothing in this codebase objecting. The agent already knows what the
 * request should cost, from the same `@vaultradar/core` price functions the service
 * prices with, so the quote is the bound (`./quote`).
 *
 * Throws rather than filtering the requirement out. A policy that returns `[]` makes
 * @x402/core raise `All payment requirements were filtered out by policies`, which says
 * nothing about the amounts involved; throwing here puts both numbers in the message the
 * caller sees (wrapped by `@x402/fetch` as `Failed to create payment payload: …`).
 *
 * `rails/arc.ts`'s `arcQuoteCeilingHook` is the same rule on the other rail, through
 * Circle's own pre-signing hook.
 */
export function quoteCeilingPolicy(quote: QuoteSource): PaymentPolicy {
  return (_version, requirements) => {
    const expected = quote();
    // No local quote for this request (nothing in this package does that today): leave
    // the requirements untouched rather than inventing a bound out of nothing.
    if (expected === null) return requirements;
    for (const r of requirements) {
      const reason = overQuoteReason(r.amount, expected);
      if (reason) throw new Error(`refusing to pay: ${reason}`);
    }
    return requirements;
  };
}

/**
 * Wraps `fetch` so a 402 from VaultRadar's Hedera routes is paid automatically: the
 * x402 client signs and attaches a Hedera `exact` payment (an HTS USDC transfer naming
 * the Blocky402 facilitator as fee payer) and retries once. The payment itself is not
 * exercised by the test suite (it talks to Hedera testnet), so `VaultRadarClient`
 * accepts a `payingFetch` override that tests use to bypass it; signer construction
 * *is* covered, since that is where the network-id mistake above lived.
 *
 * `quote` supplies the expected atomic amount for the request in flight; see
 * `quoteCeilingPolicy`. Omitting it keeps the previous behaviour (pay what is asked,
 * subject only to @x402/core's own spend controls), which is why `VaultRadarClient`
 * always passes one.
 */
export function payingFetchHedera(accountId: string, privateKey: string, quote?: QuoteSource) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: HEDERA_TESTNET_CAIP2 });
  const client = new x402Client().register(HEDERA_TESTNET_CAIP2, new ExactHederaScheme(signer));
  if (quote) client.registerPolicy(quoteCeilingPolicy(quote));
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
