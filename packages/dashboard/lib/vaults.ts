/**
 * Parsing and validation for the vault list a portfolio owner pastes into
 * `/portfolio`. Pure (no node built-ins, no fetch) so the same function runs in
 * the browser for instant feedback and in the `/api/scan` route as the
 * authoritative check — the client-side call is a convenience, never a gate.
 */

/** Hard cap on one purchase. Matches the service's own `limits.max_vaults`. */
export const MAX_VAULTS = 100;

/** An example id used in every error message, so the expected form is always shown. */
export const EXAMPLE_VAULT_ID = "1:0x83f20f44975d03b1b09e64809b757c47f942beea";

export type VaultListResult = { ok: true; vaults: string[] } | { ok: false; error: string };

/**
 * A vault id is `<chainId>:0x<40 hex>`. The chain id may not carry a leading zero:
 * `01:0xabc…` and `1:0xabc…` name the same vault but are different strings, so
 * allowing both would defeat the deduplication below.
 */
const VAULT_RE = /^([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;

/** Keeps user input out of unbounded error strings. */
function show(line: string): string {
  return line.length > 64 ? `${line.slice(0, 64)}...` : line;
}

/**
 * Why one line failed, phrased for whoever pasted it. Checks the specific
 * mistakes people actually make (a bare address, a checksum address with no
 * chain prefix, a truncated address) before falling back to the generic form.
 */
function reason(line: string): string {
  const colon = line.indexOf(":");
  if (colon === -1) {
    return /^0x[0-9a-fA-F]+$/.test(line)
      ? "it is missing the chain-id prefix"
      : "it has no ':' separating the chain id from the address";
  }
  const chainId = line.slice(0, colon);
  const address = line.slice(colon + 1);
  if (chainId === "") return "the chain id is empty";
  if (!/^[0-9]+$/.test(chainId)) return "the chain id must be a positive integer";
  if (chainId.length > 1 && chainId.startsWith("0")) return "the chain id must not have a leading zero";
  if (chainId === "0") return "the chain id must be a positive integer";
  if (!address.startsWith("0x")) return "the address must start with '0x'";
  const hex = address.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) return "the address must be hexadecimal after '0x'";
  return `the address must be exactly 40 hex characters after '0x' (got ${hex.length})`;
}

/**
 * Parses a pasted vault list: one `<chainId>:0x<40 hex>` per line. Blank lines
 * are ignored, addresses are lowercased, duplicates are dropped keeping first
 * position, and the result is capped at `MAX_VAULTS`.
 *
 * Deduplication happens before the cap, so pasting the same vault twice is never
 * what pushes a list over the limit. Errors name the offending line number and
 * echo the line back (truncated) — that line is the caller's own input, so it is
 * safe to return to them and it is the only way the message is actionable.
 */
export function parseVaultList(text: string): VaultListResult {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ n: i + 1, value: l.trim() }))
    .filter((l) => l.value !== "");

  if (lines.length === 0) {
    return { ok: false, error: `Paste at least one vault, one per line, as <chainId>:0x<40 hex address> (for example ${EXAMPLE_VAULT_ID}).` };
  }

  const seen = new Set<string>();
  const vaults: string[] = [];
  for (const line of lines) {
    if (!VAULT_RE.test(line.value)) {
      return { ok: false, error: `Line ${line.n} ("${show(line.value)}") is not a vault id: ${reason(line.value)}. Expected <chainId>:0x<40 hex address>, for example ${EXAMPLE_VAULT_ID}.` };
    }
    const id = line.value.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    vaults.push(id);
  }

  if (vaults.length > MAX_VAULTS) {
    return { ok: false, error: `Too many vaults: ${vaults.length}. The maximum for one scan is ${MAX_VAULTS}. Remove ${vaults.length - MAX_VAULTS} and scan them separately.` };
  }

  return { ok: true, vaults };
}
