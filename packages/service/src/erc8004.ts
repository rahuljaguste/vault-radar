import { createPublicClient, http, hexToString, type Address, type Transport } from "viem";

/** ERC-8004 IdentityRegistry `register`/`setMetadata`/`getMetadata` plus the `Registered` event. */
export const ERC8004_ABI = [
  {
    type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [
      { name: "agentURI", type: "string" },
      { name: "metadata", type: "tuple[]", components: [{ name: "metadataKey", type: "string" }, { name: "metadataValue", type: "bytes" }] },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function", name: "setMetadata", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "metadataKey", type: "string" }, { name: "metadataValue", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function", name: "getMetadata", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "metadataKey", type: "string" }],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "event", name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

/** Same IdentityRegistry address on both testnets VaultRadar uses. */
export const CHAINS: Record<string, { rpc: string; registry: Address; name: string }> = {
  "296": { rpc: "https://testnet.hashio.io/api", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", name: "hedera-testnet" },
  "5042002": { rpc: "https://rpc.testnet.arc.io", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", name: "arc-testnet" },
};

/** Metadata key the on-chain identity pins the ML-DSA-65 public-key hash under. */
export const PQ_KEY = "pq.sig.pubhash";

/**
 * Reads the on-chain PQ signing-key hash for an ERC-8004 agent (spec: identity
 * anchoring), for comparison against a service's `/.well-known/agent.json` card
 * (`card.pq.sig.pub_hash`). `getMetadata` returns the hash as raw bytes holding its
 * UTF-8 hex-string encoding (not the raw hash bytes themselves), so this decodes the
 * same way the card's JSON field reads.
 *
 * `transport` defaults to a real `http(rpcUrl)` transport and exists as a parameter
 * purely so tests can inject a fake viem `custom()` transport instead — nothing outside
 * this module calls `readPqHash` today (confirmed by search), so this is a safe,
 * additive extension of the plan's `readPqHash(chainId, agentId, rpcUrl)` signature.
 *
 * Never throws: an unrecognized chainId, an agentId that isn't a valid uint256, an RPC
 * failure, a revert, or empty/absent metadata all yield `null` — "could not verify" —
 * distinct from a real hash mismatch a caller would compute itself.
 */
export async function readPqHash(
  chainId: string,
  agentId: string,
  rpcUrl: string | undefined = CHAINS[chainId]?.rpc,
  transport: Transport = http(rpcUrl),
): Promise<string | null> {
  const c = CHAINS[chainId];
  if (!c) return null;
  try {
    const client = createPublicClient({ transport });
    const raw = await client.readContract({ address: c.registry, abi: ERC8004_ABI, functionName: "getMetadata", args: [BigInt(agentId), PQ_KEY] });
    return raw && raw !== "0x" ? hexToString(raw) : null;
  } catch {
    return null;
  }
}
