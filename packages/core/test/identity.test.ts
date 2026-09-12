import { expect, test } from "bun:test";
import { formatPins, matchesIdentityPin, parseIdentityPin } from "../src/identity";

test("parseIdentityPin reads a comma-separated chainId:agentId list", () => {
  expect(parseIdentityPin("296:112,5042002:894342")).toEqual([
    { chainId: "296", agentId: "112" },
    { chainId: "5042002", agentId: "894342" },
  ]);
  expect(parseIdentityPin(" 296 : 112 , ")).toEqual([{ chainId: "296", agentId: "112" }]);
});

test("parseIdentityPin treats absent and empty as pinning nothing", () => {
  for (const empty of [undefined, null, "", "   "]) expect(parseIdentityPin(empty)).toEqual([]);
});

// A typo that silently checked nothing would be worse than a startup failure: the operator
// would believe they had verified an identity when the pin never applied.
test("parseIdentityPin rejects a malformed entry rather than dropping it", () => {
  expect(() => parseIdentityPin("296")).toThrow(/must be written as/);
  expect(() => parseIdentityPin("296:")).toThrow(/must be written as/);
  expect(() => parseIdentityPin(":112")).toThrow(/must be written as/);
  expect(() => parseIdentityPin("296:112:extra")).toThrow(/must be written as/);
});

test("matchesIdentityPin passes when nothing is pinned, and requires a claimed match when something is", () => {
  const claimed = [{ chainId: "296", agentId: "112" }, { chainId: "5042002", agentId: "894342" }];
  expect(matchesIdentityPin(claimed, [])).toBe(true);
  expect(matchesIdentityPin(claimed, [{ chainId: "296", agentId: "112" }])).toBe(true);
  // Any one expected identity is enough — a service need not be the same agent id on both
  // chains it registers on.
  expect(matchesIdentityPin(claimed, [{ chainId: "5042002", agentId: "894342" }])).toBe(true);
  // An impostor's own registration: on chain, correctly anchored, and not who we expect.
  expect(matchesIdentityPin(claimed, [{ chainId: "5042002", agentId: "77" }])).toBe(false);
  expect(matchesIdentityPin([], [{ chainId: "296", agentId: "112" }])).toBe(false);
  // Same agent number on a different chain is not the same identity.
  expect(matchesIdentityPin(claimed, [{ chainId: "8453", agentId: "112" }])).toBe(false);
});

test("formatPins renders what the operator wrote, for error messages", () => {
  expect(formatPins([{ chainId: "296", agentId: "112" }])).toBe("296:112");
  expect(formatPins([])).toBe("");
});
