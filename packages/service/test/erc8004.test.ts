import { expect, test } from "bun:test";
import { custom, encodeFunctionResult, stringToHex, type EIP1193RequestFn } from "viem";
import { CHAINS, ERC8004_ABI, PQ_KEY, readPqHash } from "../src/erc8004";

/** A minimal viem `custom()` transport whose `request` is fully under test control —
 * no network access, ever. */
function fakeTransport(request: EIP1193RequestFn) {
  return custom({ request });
}

test("CHAINS names both testnets at the documented registry address", () => {
  expect(CHAINS["296"]).toEqual({ rpc: "https://testnet.hashio.io/api", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", name: "hedera-testnet" });
  expect(CHAINS["5042002"]).toEqual({ rpc: "https://rpc.testnet.arc.io", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", name: "arc-testnet" });
  expect(PQ_KEY).toBe("pq.sig.pubhash");
});

test("readPqHash decodes getMetadata's returned bytes as a UTF-8 string, via a fake transport", async () => {
  const pubHash = "ab".repeat(32);
  const encoded = encodeFunctionResult({ abi: ERC8004_ABI, functionName: "getMetadata", result: stringToHex(pubHash) });
  const calls: string[] = [];
  const transport = fakeTransport((async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === "eth_call") return encoded;
    if (method === "eth_chainId") return "0x128";
    return null;
  }) as EIP1193RequestFn);

  const result = await readPqHash("296", "7", "http://fake.invalid", transport);
  expect(result).toBe(pubHash);
  expect(calls).toContain("eth_call");
});

test("readPqHash returns null when the call reverts, without throwing", async () => {
  const transport = fakeTransport((async ({ method }: { method: string }) => {
    if (method === "eth_call") throw new Error("execution reverted");
    if (method === "eth_chainId") return "0x128";
    return null;
  }) as EIP1193RequestFn);

  expect(await readPqHash("296", "7", "http://fake.invalid", transport)).toBeNull();
});

test("readPqHash returns null for empty metadata (0x) without decoding it", async () => {
  const transport = fakeTransport((async ({ method }: { method: string }) => {
    if (method === "eth_call") return "0x";
    if (method === "eth_chainId") return "0x128";
    return null;
  }) as EIP1193RequestFn);

  expect(await readPqHash("296", "7", "http://fake.invalid", transport)).toBeNull();
});

test("readPqHash returns null for non-UTF-8 metadata bytes, instead of a garbled string", async () => {
  // 0xff is never a valid UTF-8 leading byte, so a fatal decoder must reject it.
  const encoded = encodeFunctionResult({ abi: ERC8004_ABI, functionName: "getMetadata", result: "0xff" });
  const transport = fakeTransport((async ({ method }: { method: string }) => {
    if (method === "eth_call") return encoded;
    if (method === "eth_chainId") return "0x128";
    return null;
  }) as EIP1193RequestFn);

  expect(await readPqHash("296", "7", "http://fake.invalid", transport)).toBeNull();
});

test("readPqHash returns null for valid UTF-8 that isn't a 64-hex-char hash", async () => {
  const encoded = encodeFunctionResult({ abi: ERC8004_ABI, functionName: "getMetadata", result: stringToHex("hello world") });
  const transport = fakeTransport((async ({ method }: { method: string }) => {
    if (method === "eth_call") return encoded;
    if (method === "eth_chainId") return "0x128";
    return null;
  }) as EIP1193RequestFn);

  expect(await readPqHash("296", "7", "http://fake.invalid", transport)).toBeNull();
});

test("readPqHash returns null for an unrecognized chain id, without constructing a client", async () => {
  let calledTransport = false;
  const transport = fakeTransport((async () => {
    calledTransport = true;
    return null;
  }) as EIP1193RequestFn);
  expect(await readPqHash("999999", "7", "http://fake.invalid", transport)).toBeNull();
  expect(calledTransport).toBe(false);
});
