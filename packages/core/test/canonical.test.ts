import { expect, test } from "bun:test";
import { canonicalize, hashJson } from "../src/canonical";

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
