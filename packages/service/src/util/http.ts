/**
 * Every 4xx JSON body this service produces carries `reason` (this codebase's own
 * convention, asserted throughout the existing test suite) plus `error` as an alias of
 * the same value. The alias exists because `@circle-fin/x402-batching`'s `GatewayClient`
 * (the Arc rail's client) throws using `error.error` when a paid request comes back
 * non-2xx (see its compiled `pay()`: `` `Payment failed: ${error.error || ...}` ``) — a
 * body with only `reason` would surface as "Payment failed: undefined" to an Arc caller.
 * Adding `error` alongside `reason` (never replacing it) keeps every existing assertion
 * on `reason` intact while making the same body legible to that client too.
 */
export function errBody(reason: string): { reason: string; error: string } {
  return { reason, error: reason };
}
