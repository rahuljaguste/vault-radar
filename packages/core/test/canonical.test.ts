import { expect, test } from "bun:test";
import { canonicalize, hashJson } from "../src/canonical";
import { fromHex } from "../src/util/bytes";

test("sorts keys recursively and strips whitespace", () => {
  expect(canonicalize({ b: 1, a: { d: "x", c: [3, { z: 1, y: 2 }] } }))
    .toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":"x"},"b":1}');
});
test("rejects non-integer numbers (numerics must be strings)", () => {
  expect(() => canonicalize({ a: 1.5 })).toThrow();
});
test("hash is stable across key order", () => {
  expect(hashJson({ a: "1", b: "2" })).toBe(hashJson({ b: "2", a: "1" }));
  expect(hashJson({ a: "1" })).toMatch(/^[0-9a-f]{64}$/);
});
test("undefined properties are dropped, null kept", () => {
  expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
});

test("rejects Date instances", () => {
  expect(() => canonicalize(new Date(0))).toThrow();
});
test("rejects Map instances nested in objects", () => {
  expect(() => canonicalize({ a: new Map() })).toThrow();
});
test("rejects Uint8Array instances", () => {
  expect(() => canonicalize(new Uint8Array([1]))).toThrow();
});
test("accepts Object.create(null) as plain object", () => {
  const obj = Object.create(null);
  obj.key = "value";
  expect(canonicalize(obj)).toBe('{"key":"value"}');
});

test("rejects malformed hex in fromHex", () => {
  expect(() => fromHex("gg")).toThrow();
});
test("parses hex with 0x prefix and without", () => {
  const bytes1 = fromHex("0xff00");
  const bytes2 = fromHex("ff00");
  expect(bytes1).toEqual(new Uint8Array([255, 0]));
  expect(bytes2).toEqual(new Uint8Array([255, 0]));
});
