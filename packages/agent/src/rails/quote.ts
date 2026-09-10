/**
 * The one bound both rails refuse to pay past, and the one error they raise when they do.
 *
 * Shared rather than duplicated per rail because the two must agree: Hedera checks it in an
 * `@x402/core` payment policy, Arc in Circle's `onBeforePaymentCreation` hook, and
 * `client.ts` checks the *settled* amount against the same band afterwards. Three nearly
 * equal comparisons would drift; one function cannot.
 */

/**
 * How far above the agent's own quote a 402's demanded amount may sit before the payment
 * is refused, in basis points of the quote. One percent absorbs a rounding difference
 * between a service's USD-decimal price string and the atomic amount its middleware derives
 * from it, and nothing else: this is not a negotiating band.
 *
 * Written `BigInt(100)` rather than `100n` because `packages/dashboard` type-checks this
 * source directly (it imports the agent as a workspace source package) against Next.js's
 * ES2017 target, which rejects BigInt literals while allowing the global.
 */
export const QUOTE_TOLERANCE_BPS = BigInt(100);
const BPS_DIVISOR = BigInt(10_000);

/** The expected atomic amount for the request currently in flight, or null when the caller
 * has not quoted one. Read fresh on every 402, so one client can serve a sequence of
 * differently priced requests. */
export type QuoteSource = () => string | null;

/** Upper bound the agent will accept for a quote, in the same atomic units: the quote plus
 *  `QUOTE_TOLERANCE_BPS`. */
export function maxAcceptableAtomic(quoteAtomic: string): bigint {
  const quote = BigInt(quoteAtomic);
  return quote + (quote * QUOTE_TOLERANCE_BPS) / BPS_DIVISOR;
}

/**
 * Why a demanded amount is refused, or null when it is within the band.
 *
 * Returns the message rather than throwing, because the two rails signal a refusal
 * differently: `@x402/core` policies throw, and Circle's hook returns
 * `{ abort: true, reason }`. Both end up quoting this text, so a refusal reads the same
 * whichever rail produced it.
 */
export function overQuoteReason(demandedAtomic: string, quoteAtomic: string): string | null {
  let amount: bigint;
  try {
    amount = BigInt(demandedAtomic);
  } catch {
    return `the service demanded an unreadable amount ${JSON.stringify(demandedAtomic)}`;
  }
  const max = maxAcceptableAtomic(quoteAtomic);
  if (amount <= max) return null;
  return (
    `the service demanded ${amount} atomic units for a request quoted at ${quoteAtomic} ` +
    `(ceiling ${max}, ${Number(QUOTE_TOLERANCE_BPS) / 100}% over quote)`
  );
}
