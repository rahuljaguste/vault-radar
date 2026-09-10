import { expect, test } from "bun:test";
import { MAX_VAULTS, parseVaultList } from "../lib/vaults";

const ADDR = "0x83f20f44975d03b1b09e64809b757c47f942beea";

function ok(text: string): string[] {
  const r = parseVaultList(text);
  if (!r.ok) throw new Error(`expected a successful parse, got: ${r.error}`);
  return r.vaults;
}

function err(text: string): string {
  const r = parseVaultList(text);
  if (r.ok) throw new Error(`expected a parse error, got ${r.vaults.length} vaults`);
  return r.error;
}

test("parses one vault per line, ignoring blank lines and surrounding whitespace", () => {
  expect(ok(`  1:${ADDR}  \n\n\t8453:${ADDR}\n`)).toEqual([`1:${ADDR}`, `8453:${ADDR}`]);
});

test("accepts CRLF line endings, which is what a paste from Windows produces", () => {
  expect(ok(`1:${ADDR}\r\n8453:${ADDR}`)).toEqual([`1:${ADDR}`, `8453:${ADDR}`]);
});

test("lowercases checksum-cased addresses so ids normalise to one form", () => {
  expect(ok("1:0x83F20F44975D03b1B09e64809B757c47f942BEEa")).toEqual([`1:${ADDR}`]);
});

test("deduplicates, keeping first position, across case differences", () => {
  expect(ok(`8453:${ADDR}\n1:${ADDR}\n8453:0x83F20F44975D03b1B09e64809B757c47f942BEEa`)).toEqual([
    `8453:${ADDR}`,
    `1:${ADDR}`,
  ]);
});

test("an empty or whitespace-only list is an error naming the expected form", () => {
  for (const text of ["", "   ", "\n\n", "\t\r\n "]) {
    expect(err(text)).toMatch(/Paste at least one vault.*<chainId>:0x<40 hex address>/);
  }
});

test("accepts exactly MAX_VAULTS and rejects one more, naming how many to remove", () => {
  const line = (i: number) => `1:0x${i.toString(16).padStart(40, "0")}`;
  const atLimit = Array.from({ length: MAX_VAULTS }, (_, i) => line(i)).join("\n");
  expect(ok(atLimit)).toHaveLength(MAX_VAULTS);

  const overLimit = Array.from({ length: MAX_VAULTS + 3 }, (_, i) => line(i)).join("\n");
  expect(err(overLimit)).toBe(
    `Too many vaults: ${MAX_VAULTS + 3}. The maximum for one scan is ${MAX_VAULTS}. Remove 3 and scan them separately.`,
  );
});

test("duplicates are removed before the cap, so pasting the same vault twice never trips it", () => {
  const unique = Array.from({ length: MAX_VAULTS }, (_, i) => `1:0x${i.toString(16).padStart(40, "0")}`);
  // MAX_VAULTS distinct vaults, each listed twice: 2 * MAX_VAULTS lines, still legal.
  expect(ok([...unique, ...unique].join("\n"))).toHaveLength(MAX_VAULTS);
});

test("a bare address is rejected with the missing-prefix reason and its line number", () => {
  const message = err(`1:${ADDR}\n${ADDR}`);
  expect(message).toContain("Line 2");
  expect(message).toContain("it is missing the chain-id prefix");
});

test("a line with no colon at all says so", () => {
  expect(err("not a vault")).toContain("it has no ':' separating the chain id from the address");
});

test("an empty chain id, a non-numeric one, a zero one and a leading-zero one each get their own reason", () => {
  expect(err(`:${ADDR}`)).toContain("the chain id is empty");
  expect(err(`mainnet:${ADDR}`)).toContain("the chain id must be a positive integer");
  expect(err(`0:${ADDR}`)).toContain("the chain id must be a positive integer");
  expect(err(`01:${ADDR}`)).toContain("the chain id must not have a leading zero");
});

test("an address without 0x, with non-hex characters, or of the wrong length each get their own reason", () => {
  expect(err("1:83f20f44975d03b1b09e64809b757c47f942beea")).toContain("the address must start with '0x'");
  expect(err(`1:0x${"z".repeat(40)}`)).toContain("the address must be hexadecimal after '0x'");
  expect(err(`1:0x${"a".repeat(39)}`)).toContain("the address must be exactly 40 hex characters after '0x' (got 39)");
  expect(err(`1:0x${"a".repeat(41)}`)).toContain("the address must be exactly 40 hex characters after '0x' (got 41)");
});

test("a long junk line is truncated in the error so the message stays bounded", () => {
  const message = err("x".repeat(500));
  expect(message).toContain("...");
  expect(message.length).toBeLessThan(300);
});

test("the first bad line is what is reported, not the last", () => {
  expect(err(`bad-one\nbad-two`)).toContain("Line 1");
});

test("a trailing comma is a parse error rather than being silently stripped", () => {
  // Commas only separate ids in the `?vaults=` query string, where the route
  // converts them to newlines before parsing. In a pasted textarea they are a
  // mistake, and a silent strip would hide a malformed paste.
  expect(err(`1:${ADDR},`)).toContain("Line 1");
});
