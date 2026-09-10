import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli";
import { decodePqHash } from "../src/erc8004";
import { HEDERA_TESTNET_CAIP2, payingFetchHedera } from "../src/rails/hedera";

test("parseArgs reads the command, --flag value, --flag=value and bare flags", () => {
  expect(parseArgs(["watch", "--vaults", "1:0xa,1:0xb", "--policy", "p.json"])).toEqual({
    command: "watch",
    flags: { vaults: "1:0xa,1:0xb", policy: "p.json" },
  });
  expect(parseArgs(["watch", "--vaults=1:0xa", "--rail=arc"])).toEqual({
    command: "watch",
    flags: { vaults: "1:0xa", rail: "arc" },
  });
  expect(parseArgs(["chat", "--help"])).toEqual({ command: "chat", flags: { help: true } });
  // A flag immediately followed by another flag takes no value.
  expect(parseArgs(["watch", "--sealed", "--policy", "p.json"])).toEqual({
    command: "watch",
    flags: { sealed: true, policy: "p.json" },
  });
  // The first bare word is the command; later bare words are not mistaken for one.
  expect(parseArgs(["watch", "extra"]).command).toBe("watch");
  expect(parseArgs([])).toEqual({ command: null, flags: {} });
  // An `=` inside a value survives.
  expect(parseArgs(["chat", "--service=http://h/?a=b"]).flags.service).toBe("http://h/?a=b");
});

test("the Hedera signer is built with the CAIP-2 network id the x402 library requires", () => {
  // `@x402/hedera` asserts its network option against "hedera:mainnet"/"hedera:testnet"
  // and throws `Unsupported Hedera network: testnet` for the bare form. Construction is
  // local (no network traffic), so this pins the identifier without paying anything.
  expect(HEDERA_TESTNET_CAIP2).toBe("hedera:testnet");
  const key = "1".repeat(64);
  expect(() => payingFetchHedera("0.0.42", key)).not.toThrow();
  expect(typeof payingFetchHedera("0.0.42", key)).toBe("function");
});

test("decodePqHash is strict: invalid UTF-8 and non-hash strings are 'could not verify', not a mismatch", () => {
  const hash = "ab".repeat(32); // 64 lowercase hex chars
  const hex = (s: string) => ("0x" + Buffer.from(s, "utf8").toString("hex")) as `0x${string}`;

  // The happy path: the on-chain bytes spell the card's hex hash.
  expect(decodePqHash(hex(hash))).toBe(hash);
  expect(decodePqHash(hex(`  ${hash}\n`))).toBe(hash); // surrounding whitespace is trimmed

  // Invalid UTF-8. With a non-fatal decoder these bytes become U+FFFD replacement
  // characters and sail past a length-only check; `fatal: true` rejects them outright.
  expect(decodePqHash("0xff" as `0x${string}`)).toBeNull();
  expect(decodePqHash(("0x" + "ff".repeat(64)) as `0x${string}`)).toBeNull();
  // A lone UTF-8 continuation byte appended to an otherwise valid hash.
  expect(decodePqHash((hex(hash) + "80") as `0x${string}`)).toBeNull();

  // Valid UTF-8 that is not a 32-byte hash: wrong length, uppercase, non-hex, or prose.
  expect(decodePqHash(hex("ab".repeat(31)))).toBeNull(); // 62 chars
  expect(decodePqHash(hex("ab".repeat(33)))).toBeNull(); // 66 chars
  expect(decodePqHash(hex(hash.toUpperCase()))).toBeNull();
  expect(decodePqHash(hex("z".repeat(64)))).toBeNull();
  expect(decodePqHash(hex("not a hash"))).toBeNull();
  expect(decodePqHash(hex(""))).toBeNull();
  expect(decodePqHash("0x" as `0x${string}`)).toBeNull(); // empty metadata value
});
