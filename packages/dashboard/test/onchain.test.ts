import { expect, test } from "bun:test";
import {
  ERC8004_CHAIN_RPC as AGENT_CHAIN_RPC,
  ERC8004_METADATA_ABI as AGENT_METADATA_ABI,
  PQ_SIG_PUBHASH_KEY as AGENT_PUBHASH_KEY,
  ERC8004_REGISTRY_ADDRESS as AGENT_REGISTRY,
  decodePqHash as agentDecodePqHash,
} from "@vaultradar/agent";
import {
  ERC8004_CHAIN_RPC,
  ERC8004_METADATA_ABI,
  ERC8004_REGISTRY_ADDRESS,
  PQ_SIG_PUBHASH_KEY,
  checkAnchor,
  decodePqHash,
  readPqHashOnChain,
} from "../lib/onchain";

const HASH = "ab".repeat(32);
const hexOf = (text: string) => `0x${Buffer.from(text, "utf8").toString("hex")}` as `0x${string}`;

test("every constant matches the agent's, which is what stops the two readers drifting apart", () => {
  // `/verify` restates this read rather than importing the agent's (whose package barrel
  // drags the Claude Agent SDK and both x402 rails into the browser bundle). This test is
  // the seam: change the registry address, the metadata key, the ABI or an RPC endpoint on
  // the agent side and the dashboard fails here instead of silently checking a different
  // registry than the agent pays against.
  expect(ERC8004_REGISTRY_ADDRESS).toBe(AGENT_REGISTRY);
  expect(PQ_SIG_PUBHASH_KEY).toBe(AGENT_PUBHASH_KEY);
  expect(ERC8004_CHAIN_RPC).toEqual(AGENT_CHAIN_RPC);
  expect(ERC8004_METADATA_ABI).toEqual(AGENT_METADATA_ABI);
  // And the two testnets the spec names are the two that are covered.
  expect(ERC8004_CHAIN_RPC["296"]).toBe("https://testnet.hashio.io/api");
  expect(ERC8004_CHAIN_RPC["5042002"]).toBe("https://rpc.testnet.arc.io");
});

test("decodePqHash accepts a pinned hash and agrees with the agent's decoder on every input", () => {
  const inputs: `0x${string}`[] = [
    hexOf(HASH),
    hexOf(`  ${HASH}  `), // trimmed
    hexOf(HASH.toUpperCase()), // upper case is not the card's format
    hexOf(HASH.slice(0, 63)), // truncated write
    hexOf(`${HASH}00`), // too long
    hexOf("not a hash at all"),
    "0x" as `0x${string}`, // key absent: getMetadata returns empty bytes
    "0xff", // invalid UTF-8
  ];
  expect(decodePqHash(inputs[0])).toBe(HASH);
  expect(decodePqHash(inputs[1])).toBe(HASH);
  for (const raw of inputs.slice(2)) expect(decodePqHash(raw)).toBeNull();
  for (const raw of inputs) expect(decodePqHash(raw)).toBe(agentDecodePqHash(raw));
});

test("checkAnchor reports matches, mismatch and unavailable as three distinct states", async () => {
  const id = { chainId: "296", agentId: "7" };
  expect(await checkAnchor(id, HASH, async () => HASH)).toEqual({ ...id, state: "matches", onChain: HASH });
  expect(await checkAnchor(id, HASH, async () => "00".repeat(32))).toEqual({ ...id, state: "mismatch", onChain: "00".repeat(32) });
  // A registry that cannot be read, or holds nothing for this agent, is "unavailable" —
  // not a mismatch, because claiming a substitution where there is only a failed read
  // would report an attack that did not happen.
  expect(await checkAnchor(id, HASH, async () => null)).toEqual({ ...id, state: "unavailable", onChain: null });
});

test("checkAnchor compares case-insensitively, so the same hash in different case is not an accusation", async () => {
  const id = { chainId: "5042002", agentId: "3" };
  expect((await checkAnchor(id, HASH.toUpperCase(), async () => HASH)).state).toBe("matches");
  expect((await checkAnchor(id, `  ${HASH}  `, async () => HASH)).state).toBe("matches");
});

test("readPqHashOnChain returns null for a chain with no configured RPC, without a network call", async () => {
  expect(await readPqHashOnChain("999999", "1")).toBeNull();
  expect(await readPqHashOnChain("", "1")).toBeNull();
});

test("readPqHashOnChain returns null rather than throwing for an agent id that is not a uint256", async () => {
  // `BigInt("not-a-number")` throws, and a throw out of here would break the page rather
  // than render "unavailable" for one identity.
  expect(await readPqHashOnChain("296", "not-a-number")).toBeNull();
});
