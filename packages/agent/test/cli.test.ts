import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli";
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
