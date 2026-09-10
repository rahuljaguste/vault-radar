import { expect, test } from "bun:test";
import { deriveSigningKeys } from "@vaultradar/core";
import { decodeFunctionData, hexToString } from "viem";
import { ERC8004_ABI, PQ_KEY } from "../src/erc8004";
import { agentUriFor, buildRegisterCalldata } from "../scripts/identity";

test("agentUriFor builds the well-known erc8004.json URL, trimming a trailing slash", () => {
  expect(agentUriFor("https://svc.example/")).toBe("https://svc.example/.well-known/erc8004.json");
  expect(agentUriFor("https://svc.example")).toBe("https://svc.example/.well-known/erc8004.json");
});

test("buildRegisterCalldata encodes a register() call carrying the agentURI and the UTF-8 pub hash under PQ_KEY", () => {
  const agentURI = "https://svc.example/.well-known/erc8004.json";
  const pubHash = "deadbeef".repeat(8); // 64 hex chars, a plausible sha256 hex digest
  const calldata = buildRegisterCalldata(agentURI, pubHash);
  expect(calldata.startsWith("0x")).toBe(true);

  const decoded = decodeFunctionData({ abi: ERC8004_ABI, data: calldata });
  expect(decoded.functionName).toBe("register");
  const [decodedUri, metadata] = decoded.args as [string, { metadataKey: string; metadataValue: `0x${string}` }[]];
  expect(decodedUri).toBe(agentURI);
  expect(metadata).toHaveLength(1);
  expect(metadata[0].metadataKey).toBe(PQ_KEY);
  expect(hexToString(metadata[0].metadataValue)).toBe(pubHash);
});

test("--dry-run prints the agentURI and calldata for this seed's derived pub hash, with no deployer key and no network access", async () => {
  const sigSeed = "11".repeat(32);
  const expectedPubHash = deriveSigningKeys(sigSeed).pubHash;
  const proc = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/../scripts/identity.ts`, "--dry-run"],
    env: { ...process.env, PQ_SIG_SEED: sigSeed, PUBLIC_URL: "https://svc.example", DEPLOYER_KEY_HEDERA: "", DEPLOYER_KEY_ARC: "", HEDERA_HCS_TOPIC_ID: "", HEDERA_OPERATOR_ID: "", HEDERA_OPERATOR_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("agentURI=https://svc.example/.well-known/erc8004.json");

  const calldataLine = stdout.split("\n").find(l => l.includes("calldata="));
  expect(calldataLine).toBeDefined();
  const calldata = calldataLine!.slice(calldataLine!.indexOf("calldata=") + "calldata=".length).trim() as `0x${string}`;
  const decoded = decodeFunctionData({ abi: ERC8004_ABI, data: calldata });
  const [, metadata] = decoded.args as [string, { metadataKey: string; metadataValue: `0x${string}` }[]];
  expect(hexToString(metadata[0].metadataValue)).toBe(expectedPubHash);
});

test("--dry-run without PQ_SIG_SEED fails fast with a clear error, before any chain or HCS call", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", `${import.meta.dir}/../scripts/identity.ts`, "--dry-run"],
    env: { ...process.env, PQ_SIG_SEED: "", PUBLIC_URL: "https://svc.example" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("PQ_SIG_SEED");
});
