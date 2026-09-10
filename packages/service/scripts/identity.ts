#!/usr/bin/env bun
// Identity bootstrap for VaultRadar (spec: identity anchoring).
//
//   bun run packages/service/scripts/identity.ts [--dry-run]
//
// Always needs: PQ_SIG_SEED (32 bytes hex), PUBLIC_URL.
// For a real HCS topic (skipped when HEDERA_HCS_TOPIC_ID is already set): HEDERA_OPERATOR_ID,
// HEDERA_OPERATOR_KEY.
// For a real on-chain registration: DEPLOYER_KEY_HEDERA and/or DEPLOYER_KEY_ARC (0x-prefixed
// EVM private keys of ECDSA accounts with an EVM alias). A chain with no deployer key set is
// skipped (printed, not an error) unless --dry-run, which needs no key at all since calldata
// only depends on the agentURI and the derived pub hash.
//
// --dry-run makes no network or chain calls whatsoever: it skips HCS topic creation and prints
// the exact register() calldata (and the agentURI) it would otherwise send, for both chains.
//
// Prints `KEY=value` lines to paste into .env: HEDERA_HCS_TOPIC_ID, ERC8004_HEDERA_AGENT_ID,
// ERC8004_ARC_AGENT_ID.
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client, PrivateKey, TopicCreateTransaction } from "@hashgraph/sdk";
import { deriveSigningKeys } from "@vaultradar/core";
import { CHAINS, ERC8004_ABI, PQ_KEY } from "../src/erc8004";

/** The well-known URL an ERC-8004 registration should point `agentURI` at. */
export function agentUriFor(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, "")}/.well-known/erc8004.json`;
}

/** The single-entry `register()`/`writeContract` metadata tuple, keyed under PQ_KEY. */
function metadataArgs(pubHash: string): { metadataKey: string; metadataValue: `0x${string}` }[] {
  return [{ metadataKey: PQ_KEY, metadataValue: stringToHex(pubHash) }];
}

/** The exact `register(agentURI, [{metadataKey: PQ_KEY, metadataValue}])` calldata. */
export function buildRegisterCalldata(agentURI: string, pubHash: string): `0x${string}` {
  return encodeFunctionData({
    abi: ERC8004_ABI,
    functionName: "register",
    args: [agentURI, metadataArgs(pubHash)],
  });
}

const DEPLOYER_KEY_ENV: Record<string, string> = { "296": "DEPLOYER_KEY_HEDERA", "5042002": "DEPLOYER_KEY_ARC" };
const AGENT_ID_ENV: Record<string, string> = { "296": "ERC8004_HEDERA_AGENT_ID", "5042002": "ERC8004_ARC_AGENT_ID" };

async function createHcsTopicIfNeeded(): Promise<void> {
  if (process.env.HEDERA_HCS_TOPIC_ID) return;
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    console.log("skip HCS topic creation: HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set");
    return;
  }
  const client = Client.forTestnet().setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));
  const rc = await (await new TopicCreateTransaction().setTopicMemo("VaultRadar receipt commitments v1").execute(client)).getReceipt(client);
  console.log("HEDERA_HCS_TOPIC_ID=" + rc.topicId!.toString());
}

async function registerOnChain(chainId: string, deployerKey: string | undefined, agentURI: string, pubHash: string, dryRun: boolean): Promise<void> {
  const c = CHAINS[chainId];
  if (dryRun) {
    console.log(`[dry-run] ${c.name}: agentURI=${agentURI}`);
    console.log(`[dry-run] ${c.name}: calldata=${buildRegisterCalldata(agentURI, pubHash)}`);
    return;
  }
  if (!deployerKey) {
    console.log(`skip ${chainId}: no deployer key (${DEPLOYER_KEY_ENV[chainId]} not set)`);
    return;
  }
  const chain = defineChain({
    id: Number(chainId), name: c.name,
    nativeCurrency: { name: "native", symbol: chainId === "296" ? "HBAR" : "USDC", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
  });
  const account = privateKeyToAccount(deployerKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(c.rpc) });
  const pub = createPublicClient({ chain, transport: http(c.rpc) });
  const hash = await wallet.writeContract({
    address: c.registry, abi: ERC8004_ABI, functionName: "register",
    args: [agentURI, metadataArgs(pubHash)],
    gas: 400_000n,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  const ev = rcpt.logs
    .map(l => {
      try {
        return decodeEventLog({ abi: ERC8004_ABI, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find(e => e?.eventName === "Registered") as any;
  console.log(`${c.name}: agentId=${ev?.args?.agentId?.toString()} tx=${hash}`);
  console.log(`${AGENT_ID_ENV[chainId]}=${ev?.args?.agentId?.toString()}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const sigSeed = process.env.PQ_SIG_SEED;
  if (!sigSeed) throw new Error("PQ_SIG_SEED is required: 32 bytes hex, e.g. `openssl rand -hex 32`");
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) throw new Error("PUBLIC_URL is required, e.g. https://your-service.example");

  const pubHash = deriveSigningKeys(sigSeed).pubHash;
  const agentURI = agentUriFor(publicUrl);

  if (!dryRun) await createHcsTopicIfNeeded();

  for (const chainId of Object.keys(CHAINS)) {
    await registerOnChain(chainId, process.env[DEPLOYER_KEY_ENV[chainId]], agentURI, pubHash, dryRun);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error("fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
