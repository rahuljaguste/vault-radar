import { createPublicClient, hexToString, http, type Abi } from "viem";

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

/**
 * Reads the ML-DSA-65 public-key hash an ERC-8004 agent identity has pinned on chain,
 * for comparison against the hash the service's `/.well-known/agent.json` card claims
 * (`card.pq.sig.pub_hash`). `getMetadata` returns the hash as raw bytes holding its
 * UTF-8 hex-string encoding (not the raw hash bytes themselves), so the on-chain value
 * decodes the same way the card's JSON field reads.
 *
 * Never throws: an unrecognized chainId, an agentId that isn't a valid uint256, an RPC
 * failure, or a revert all yield `null` — "could not verify" — which the caller (see
 * `VaultRadarClient.discover`) reports as `matches: null`, distinct from an actual
 * mismatch (`matches: false`).
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
    const text = hexToString(raw as `0x${string}`).trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}
