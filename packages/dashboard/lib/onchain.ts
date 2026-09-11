import { createPublicClient, hexToBytes, http, type Abi } from "viem";

/**
 * The ERC-8004 key-binding read the `/verify` page needs, implemented for the browser.
 *
 * `packages/agent/src/erc8004.ts` does the same read for the agent, and the two must agree
 * — but the agent's package barrel also pulls in the Claude Agent SDK and both x402 rails,
 * none of which belong in a browser bundle, and its `exports` map offers no deep path. So
 * the read is restated here and `test/onchain.test.ts` asserts every constant in this file
 * equals the agent's, which is what keeps them from drifting: change the registry address
 * or an RPC endpoint on one side and the dashboard's test fails.
 */

/** ERC-8004 IdentityRegistry, at the same address on both testnets VaultRadar uses. */
export const ERC8004_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

/** Metadata key the service's on-chain identity pins its ML-DSA-65 public-key hash under. */
export const PQ_SIG_PUBHASH_KEY = "pq.sig.pubhash";

/** Just the one read-only entry point this module calls. */
export const ERC8004_METADATA_ABI = [
  {
    type: "function",
    name: "getMetadata",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const satisfies Abi;

/** chainId -> public JSON-RPC url for the two testnets an agent card's `erc8004[]` can name. */
export const ERC8004_CHAIN_RPC: Record<string, string> = {
  "296": "https://testnet.hashio.io/api", // Hedera testnet (Hashio JSON-RPC relay)
  "5042002": "https://rpc.testnet.arc.io", // Arc testnet
};

/** An ML-DSA-65 public-key hash as it appears in the agent card: 32 bytes, lowercase hex. */
const PUB_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The decode half of the read, split out so its strictness is testable without an RPC
 * endpoint. `getMetadata` returns raw bytes holding the hash's UTF-8 *hex-string* encoding
 * (not the 32 raw hash bytes), so the on-chain value decodes to the same text the card's
 * JSON field carries.
 *
 * `fatal: true` means bytes that are not valid UTF-8 throw instead of decoding to U+FFFD
 * replacement characters, and the result must match a 64-character lowercase hex hash
 * exactly. Anything else — a truncated write, a different encoding, a key holding some
 * unrelated string — is `null` ("could not verify") rather than a value that would be
 * compared and reported as a mismatch, which would read as an attack where it is really a
 * malformed registration.
 */
export function decodePqHash(raw: `0x${string}`): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(raw)).trim();
    return PUB_HASH_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** What the `/verify` page shows for one ERC-8004 identity on the card. */
export type AnchorState = "matches" | "mismatch" | "unavailable";

/**
 * Reads the pinned hash for one identity. Never throws: an unrecognized chain id, an agent
 * id that is not a valid uint256, an RPC failure, a revert, invalid UTF-8 or a non-hash
 * string all yield `null`, which the caller renders as "unavailable" — deliberately
 * distinct from a hash that was read and did not match.
 */
export async function readPqHashOnChain(chainId: string, agentId: string): Promise<string | null> {
  const rpcUrl = ERC8004_CHAIN_RPC[chainId];
  if (!rpcUrl) return null;
  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
    const raw = await client.readContract({
      address: ERC8004_REGISTRY_ADDRESS,
      abi: ERC8004_METADATA_ABI,
      functionName: "getMetadata",
      args: [BigInt(agentId), PQ_SIG_PUBHASH_KEY],
    });
    return decodePqHash(raw as `0x${string}`);
  } catch {
    return null;
  }
}

/**
 * Compares one card identity's on-chain pin against the hash the card claims.
 *
 * `read` is injectable so tests drive every branch without an RPC endpoint; production
 * callers use the default. Case is normalised on both sides, because "the same hash written
 * in different case" is the same hash and reporting it as a mismatch would accuse a correct
 * registration.
 */
export async function checkAnchor(
  identity: { chainId: string; agentId: string },
  cardPubHash: string,
  read: (chainId: string, agentId: string) => Promise<string | null> = readPqHashOnChain,
): Promise<{ chainId: string; agentId: string; state: AnchorState; onChain: string | null }> {
  const onChain = await read(identity.chainId, identity.agentId);
  const state: AnchorState =
    onChain === null ? "unavailable" : onChain.toLowerCase() === cardPubHash.trim().toLowerCase() ? "matches" : "mismatch";
  return { chainId: identity.chainId, agentId: identity.agentId, state, onChain };
}
