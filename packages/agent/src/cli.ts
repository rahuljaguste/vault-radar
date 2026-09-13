#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Rail } from "@vaultradar/core";
import { VaultRadarClient } from "./client";
import { loadPolicy, type Policy } from "./policy";
import { arcAddress } from "./rails/arc";
import { readBalances, readHealth } from "./balances";
import { runWatch } from "./watch";
import { ALLOWED_TOOLS, MCP_SERVER_NAME, RunLog, SYSTEM_PROMPT, createVaultRadarMcpServer, type AgentContext } from "./tools";

// packages/agent/src/cli.ts -> repo root is three levels up.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DEFAULT_SERVICE_URL = "http://localhost:8787";

const USAGE = `VaultRadar agent

  bun run agent watch --vaults <id,id> --policy <file> [--service URL] [--rail hedera|arc] [--runs DIR] [--protocol NAME]
  bun run agent chat [--policy <file>] [--service URL] [--runs DIR]

Vault ids are "<chainId>:<address>", e.g. 1:0x1234…abcd.

Environment:
  SERVICE_URL               VaultRadar service base URL (default ${DEFAULT_SERVICE_URL})
  POLICY_PATH               policy file, when --policy is not given
  RUNS_DIR                  where run files are written (default <repo>/runs)
  AGENT_HEDERA_ACCOUNT_ID   Hedera payer account, e.g. 0.0.12345
  AGENT_HEDERA_KEY          Hedera ECDSA private key for that account
  AGENT_ARC_KEY             Arc (Circle Gateway) private key, 0x-prefixed
  ANTHROPIC_API_KEY         required for \`chat\`; \`watch\` needs no model
`;

type Flags = Record<string, string | true>;

/** Parses `--flag value` / `--flag=value` / `--flag` into a flat map. */
export function parseArgs(argv: string[]): { command: string | null; flags: Flags } {
  const flags: Flags = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      command ??= arg;
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { command, flags };
}

const str = (flags: Flags, name: string): string | null => (typeof flags[name] === "string" ? (flags[name] as string) : null);

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

type Wallets = {
  hedera: { accountId: string; privateKey: string } | null;
  arc: { privateKey: `0x${string}` } | null;
};

/**
 * Reads wallet credentials from the environment. Keys are handed straight to
 * `VaultRadarClient` and never logged, echoed, or written to a run file; only the
 * account id and the derived Arc address (both public) are ever displayed.
 */
function readWallets(env: NodeJS.ProcessEnv): Wallets {
  const accountId = env.AGENT_HEDERA_ACCOUNT_ID?.trim();
  const hederaKey = env.AGENT_HEDERA_KEY?.trim();
  const arcKey = env.AGENT_ARC_KEY?.trim();
  if ((accountId && !hederaKey) || (!accountId && hederaKey)) {
    die("AGENT_HEDERA_ACCOUNT_ID and AGENT_HEDERA_KEY must be set together");
  }
  if (arcKey && !/^0x[0-9a-fA-F]{64}$/.test(arcKey)) {
    die("AGENT_ARC_KEY must be a 0x-prefixed 32-byte hex private key");
  }
  return {
    hedera: accountId && hederaKey ? { accountId, privateKey: hederaKey } : null,
    arc: arcKey ? { privateKey: arcKey as `0x${string}` } : null,
  };
}

type Resolved = {
  serviceUrl: string;
  runsDir: string;
  policy: Policy;
  policyPath: string;
  wallets: Wallets;
  client: VaultRadarClient;
  balances: () => Promise<{ hedera: string; arc: string }>;
  health: () => Promise<{ hedera: boolean; arc: boolean }>;
};

function resolve(flags: Flags, env: NodeJS.ProcessEnv): Resolved {
  const serviceUrl = str(flags, "service") ?? env.SERVICE_URL ?? DEFAULT_SERVICE_URL;
  const runsDir = str(flags, "runs") ?? env.RUNS_DIR ?? join(REPO_ROOT, "runs");
  const policyPath = str(flags, "policy") ?? env.POLICY_PATH ?? null;
  if (!policyPath) die("no policy: pass --policy <file> or set POLICY_PATH (see packages/agent/policy.example.json)");
  let policy: Policy;
  try {
    policy = loadPolicy(policyPath);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }

  const wallets = readWallets(env);
  if (!wallets.hedera && !wallets.arc) {
    die("no wallet configured: set AGENT_HEDERA_ACCOUNT_ID + AGENT_HEDERA_KEY, or AGENT_ARC_KEY");
  }

  const client = new VaultRadarClient({
    serviceUrl,
    ...(wallets.hedera ? { hedera: wallets.hedera } : {}),
    ...(wallets.arc ? { arc: wallets.arc } : {}),
  });

  return {
    serviceUrl,
    runsDir,
    policy,
    policyPath,
    wallets,
    client,
    balances: () =>
      readBalances({ hederaAccountId: wallets.hedera?.accountId ?? null, arcPrivateKey: wallets.arc?.privateKey ?? null }),
    health: async () => {
      const h = await readHealth({ serviceUrl });
      for (const note of h.notes) console.log(`  note          ${note}`);
      return { hedera: h.hedera, arc: h.arc };
    },
  };
}

async function watchCommand(flags: Flags, env: NodeJS.ProcessEnv): Promise<never> {
  const vaultsArg = str(flags, "vaults");
  if (!vaultsArg) die("no vaults: pass --vaults <chainId:address,chainId:address>");
  const vaults = vaultsArg
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
  if (!vaults.length) die("--vaults was empty");
  const bad = vaults.filter(v => !/^\d+:0x[0-9a-fA-F]{40}$/.test(v));
  if (bad.length) die(`not a vault id: ${bad.join(", ")} (expected <chainId>:0x<40 hex>)`);

  const railArg = str(flags, "rail");
  if (railArg && railArg !== "hedera" && railArg !== "arc") die(`--rail must be hedera or arc, got ${railArg}`);

  const r = resolve(flags, env);
  const out = await runWatch(
    {
      vaults,
      serviceUrl: r.serviceUrl,
      runsDir: r.runsDir,
      rail: (railArg as Rail | null) ?? null,
      ...(str(flags, "protocol") ? { protocol: str(flags, "protocol")! } : {}),
    },
    { client: r.client, policy: r.policy, balances: r.balances, health: r.health },
  );
  process.exit(out.exitCode);
}

/** Prints one assistant text block per line, ignoring the SDK's control frames. */
function printAssistant(message: { content?: unknown }): void {
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks as { type?: string; text?: string; name?: string }[]) {
    if (block.type === "text" && block.text) console.log(block.text);
    else if (block.type === "tool_use" && block.name) console.log(`  · ${block.name}`);
  }
}

async function chatCommand(flags: Flags, env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    die("chat needs ANTHROPIC_API_KEY (watch does not, it is deterministic and uses no model)");
  }
  // Imported lazily so `watch` never loads the agent SDK.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const r = resolve(flags, env);
  const ctx: AgentContext = {
    client: r.client,
    policy: r.policy,
    runsDir: r.runsDir,
    serviceUrl: r.serviceUrl,
    balances: r.balances,
    health: r.health,
  };
  const log = new RunLog(ctx);
  const server = createVaultRadarMcpServer(ctx, log);

  console.log(`VaultRadar agent · ${r.serviceUrl} · policy ${r.policyPath}`);
  console.log("Commands: /wallets  /balance  /policy  /run  /help  /exit\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  const slash = async (line: string): Promise<boolean> => {
    switch (line) {
      case "/help":
        console.log("/wallets  payer identities (never keys)\n/balance  spendable USDC per rail, plus facilitator health\n/policy   the loaded policy\n/run      the run file for this session\n/exit     quit");
        return true;
      case "/wallets":
        console.log(`hedera  ${r.wallets.hedera ? r.wallets.hedera.accountId : "not configured"}`);
        console.log(`arc     ${r.wallets.arc ? arcAddress(r.wallets.arc.privateKey) : "not configured"}`);
        console.log(`service ${r.serviceUrl}`);
        console.log(`runs    ${r.runsDir}`);
        return true;
      case "/balance": {
        const [b, h] = await Promise.all([r.balances(), readHealth({ serviceUrl: r.serviceUrl })]);
        console.log(`hedera  ${b.hedera} USDC   budget ${r.policy.budget.usdc_hedera}   facilitator ${h.hedera ? "up" : "down"}`);
        console.log(`arc     ${b.arc} USDC   budget ${r.policy.budget.usdc_arc}   facilitator ${h.arc ? "up" : "down"}`);
        console.log(`service ${h.service ? "up" : "down"}`);
        for (const note of h.notes) console.log(`note    ${note}`);
        return true;
      }
      case "/policy":
        console.log(JSON.stringify(r.policy, null, 2));
        return true;
      case "/run": {
        const run = log.current();
        console.log(run ? `${run.id} · ${run.requests.length} request(s) · ${run.decisions.length} decision(s)` : "no purchases yet this session");
        return true;
      }
      default:
        console.log(`unknown command ${line}, try /help`);
        return true;
    }
  };

  async function* prompts(): AsyncGenerator<{ type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null }> {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line === "/exit" || line === "/quit") return;
      if (line.startsWith("/")) {
        await slash(line);
        rl.prompt();
        continue;
      }
      yield { type: "user", message: { role: "user", content: line }, parent_tool_use_id: null };
    }
  }

  for await (const message of query({
    prompt: prompts(),
    options: {
      systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
      mcpServers: { [MCP_SERVER_NAME]: server },
      allowedTools: ALLOWED_TOOLS,
      // Only the VaultRadar tools: no file, shell, or web access for a money-spending agent.
      tools: [],
      // Ignore any CLAUDE.md or settings in the working tree.
      settingSources: [],
      cwd: REPO_ROOT,
    },
  })) {
    if (message.type === "assistant") printAssistant(message.message);
    else if (message.type === "result") rl.prompt();
  }
  rl.close();
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help || command === "help") {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }
  if (command === "watch") await watchCommand(flags, process.env);
  else if (command === "chat") await chatCommand(flags, process.env);
  else {
    console.error(`unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(2);
  }
}

// Only run when invoked directly, so tests can import `parseArgs` without starting a CLI.
if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
