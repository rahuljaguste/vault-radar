/**
 * Pinning the identity you expect a service to have.
 *
 * The on-chain anchor proves that a key is registered under an agent id, and that the card
 * serving the key agrees with the registry. It cannot prove *which* agent id belongs to the
 * service you meant to call: the ERC-8004 registry is permissionless, so an impostor who
 * controls the URL can register an agent id of their own, serve a card signed by their own
 * key naming that id, and mint a receipt that satisfies every self-consistency check. The
 * anchor binds a key to an agent id; only an operator who knows the expected agent id out of
 * band can bind an agent id to a service.
 *
 * So the pin is optional and comes from configuration, never from the thing being checked:
 * a `chainId:agentId` pair the operator learned somewhere other than the card, the receipt or
 * the registry entry they are validating. Unset means the checks run as before — honest about
 * being self-consistency — and set means a mismatch is a refusal.
 */

/** One expected on-chain identity. */
export type IdentityPin = { chainId: string; agentId: string };

/**
 * Parses `"296:112,5042002:894342"` into pins. Empty or absent yields `[]`, which pins
 * nothing. A malformed entry throws rather than being dropped: a typo in a pin that
 * silently checked nothing would be worse than a startup failure, because the operator
 * would believe they had verified something.
 */
export function parseIdentityPin(raw: string | null | undefined): IdentityPin[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [chainId, agentId, ...rest] = entry.split(":").map(s => s.trim());
      if (!chainId || !agentId || rest.length) {
        throw new Error(`expected identity ${JSON.stringify(entry)} must be written as "<chainId>:<agentId>"`);
      }
      return { chainId, agentId };
    });
}

/** The pins as they are written in configuration, for error messages. */
export const formatPins = (pins: IdentityPin[]): string =>
  pins.map(p => `${p.chainId}:${p.agentId}`).join(", ");

/**
 * Whether the identities a service claims include one the operator expects. No pins means
 * nothing to satisfy, so it passes — the pin only ever adds a requirement.
 */
export function matchesIdentityPin(claimed: IdentityPin[], pins: IdentityPin[]): boolean {
  if (!pins.length) return true;
  return claimed.some(c => pins.some(p => p.chainId === c.chainId && p.agentId === c.agentId));
}
