import { GatewayClient, type PayResult } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import { overQuoteReason } from "./quote";

export type ArcPayResult<T = unknown> = PayResult<T>;

/** Derives the payer address for an Arc private key without touching the network —
 *  used both to fill in `payer` on a sealed request and, in tests, to compute the
 *  expected payer with no Gateway client involved. */
export function arcAddress(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address;
}

/**
 * The minimum of Circle's `GatewayClient` this module registers a hook on. Declared
 * structurally so a test can hand in a stub and drive the refusal without a real Gateway
 * wallet; `GatewayClient` itself satisfies it.
 *
 * `onBeforePaymentCreation` is Circle's own pre-signing hook: it fires inside
 * `createPaymentPayload`, and a returned `{ abort: true, reason }` makes `pay()` throw
 * `Payment creation aborted: <reason>` before the EIP-3009 authorization is built or signed
 * (traced in `@circle-fin/x402-batching` 3.4.0's compiled `dist/client/index.js`).
 */
export type ArcPayer<T> = {
  onBeforePaymentCreation(
    hook: (context: { selectedRequirements: { amount: string } }) => Promise<void | { abort: true; reason: string }>,
  ): unknown;
  pay(url: string, options: { method: string; body: unknown; headers: Record<string, string> }): Promise<PayResult<T>>;
};

/**
 * Refuses, before anything is signed, any requirement demanding more than the agent quoted.
 *
 * This is `rails/hedera.ts`'s `quoteCeilingPolicy` on the other rail, and it closes the same
 * hole: `payArc` used to hand the 402's demanded amount straight to Circle's client, which
 * signed an authorization for it. The mismatch was caught only afterwards, by the receipt
 * check in `client.ts` — and on this rail "afterwards" is after Circle has settled, so the
 * money was already gone. The bound and the wording come from `./quote`, so a refusal reads
 * the same whichever rail produced it.
 *
 * Circle's hook has no equivalent of @x402/core's default `$1` spend control, so before this
 * there was no ceiling on an Arc payment at all.
 */
export function arcQuoteCeilingHook(quoteAtomic: string) {
  return async (context: { selectedRequirements: { amount: string } }) => {
    const reason = overQuoteReason(context.selectedRequirements.amount, quoteAtomic);
    return reason ? ({ abort: true, reason: `refusing to pay: ${reason}` } as const) : undefined;
  };
}

/**
 * Pays a VaultRadar Arc route via Circle's Gateway nanopayment batching (EIP-3009,
 * settled off-chain until the facilitator batches it). Builds a fresh `GatewayClient`
 * per call rather than caching one on the client instance, since a `VaultRadarClient`
 * may never touch the Arc rail at all (Hedera-only usage should never construct a
 * Gateway wallet). Not exercised by the test suite (it talks to Arc testnet).
 *
 * A fresh client per call is also what makes the quote ceiling simple here: the expected
 * amount is known at the call site, so it is registered on this client for this one payment
 * rather than read from a mutable field the way the Hedera rail has to.
 */
export async function payArc<T = unknown>(
  privateKey: `0x${string}`,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  quoteAtomic?: string,
): Promise<ArcPayResult<T>> {
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
  return payArcWith<T>(gateway as unknown as ArcPayer<T>, url, body, headers, quoteAtomic);
}

/** The rail's logic with the client injected, so the ceiling is testable without a wallet. */
export async function payArcWith<T = unknown>(
  gateway: ArcPayer<T>,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  quoteAtomic?: string,
): Promise<ArcPayResult<T>> {
  // `!= null`, not truthiness: `"0"` and `""` are both falsy strings and both *are*
  // quotes — of zero. Those are the cases where the ceiling bites hardest, since
  // `overQuoteReason` then refuses any non-zero demand at all (`BigInt("")` is `0n`).
  // Skipping the hook for them registered no ceiling precisely when a service demanding
  // money for a free request should have been refused outright.
  if (quoteAtomic != null) gateway.onBeforePaymentCreation(arcQuoteCeilingHook(quoteAtomic));
  return gateway.pay(url, { method: "POST", body, headers });
}
