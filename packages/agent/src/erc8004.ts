import { createPublicClient, hexToBytes, http, type Abi } from "viem";

/** ERC-8004 IdentityRegistry, deployed at the same address on both testnets VaultRadar uses. */
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

/** chainId -> JSON-RPC url for the two testnets the agent card's `erc8004[]` can name. */
export const ERC8004_CHAIN_RPC: Record<string, string> = {
  "296": "https://testnet.hashio.io/api", // Hedera testnet (Hashio JSON-RPC relay)
  "5042002": "https://rpc.testnet.arc.io", // Arc testnet
};

/** An ML-DSA-65 public-key hash as it appears in the agent card: 32 bytes, lowercase hex. */
const PUB_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Reads the ML-DSA-65 public-key hash an ERC-8004 agent identity has pinned on chain,
 * for comparison against the hash the service's `/.well-known/agent.json` card claims
 * (`card.pq.sig.pub_hash`). `getMetadata` returns the hash as raw bytes holding its
 * UTF-8 hex-string encoding (not the raw hash bytes themselves), so the on-chain value
 * decodes the same way the card's JSON field reads.
 *
 * The decode is strict in both directions, because this value decides whether the agent
 * pays a service at all. `TextDecoder` runs with `fatal: true`, so bytes that are not
 * valid UTF-8 throw rather than silently becoming U+FFFD replacement characters; and the
 * result must match a 64-character lowercase hex hash exactly. Anything else — a
 * truncated write, a different encoding, a key holding some unrelated string — is
 * `null` ("could not verify") rather than a value that would be compared and reported as
 * a mismatch, which would read as an attack where it is really a malformed registration.
 *
 * Never throws: an unrecognized chainId, an agentId that isn't a valid uint256, an RPC
 * failure, a revert, invalid UTF-8, or a non-hash string all yield `null`, which the
 * caller (see `VaultRadarClient.discover`) reports as `matches: null`, distinct from an
 * actual mismatch (`matches: false`).
 */
export async function readPqHashOnChain(chainId: string, agentId: string): Promise<string | null> {
  const rpcUrl = ERC8004_CHAIN_RPC[chainId];
  if (!rpcUrl) return null;
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
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
 * The decode-and-validate half of `readPqHashOnChain`, split out so the strictness can be
 * tested without an RPC endpoint. Returns the pinned hash, or null if the bytes are not
 * valid UTF-8 or do not spell a 64-character lowercase hex hash.
 *
 * `fatal: true` means invalid UTF-8 throws rather than decoding to U+FFFD replacement
 * characters, which would otherwise fail the hex check for the wrong reason — and, for a
 * key that happened to hold 64 hex-looking characters, could have passed it.
 */
export function decodePqHash(raw: `0x${string}`): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(raw)).trim();
    return PUB_HASH_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}
