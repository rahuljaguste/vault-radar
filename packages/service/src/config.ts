export type Config = {
  port: number;
  publicUrl: string;
  sigSeed: string;
  kemSeed: string;
  graphApiKey: string;
  databaseUrl: string | null;
  rpc: { "1": string; "8453": string };
  hedera: {
    network: "testnet";
    payToAccountId: string;
    operatorId: string;
    operatorKey: string;
    facilitatorUrl: string;
    usdcToken: string;
    hcsTopicId: string | null;
  };
  arc: { sellerAddress: string; facilitatorUrl: string; network: "eip155:5042002" };
  erc8004: { chainId: string; agentId: string }[];
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const sigSeed = env.PQ_SIG_SEED;
  if (!sigSeed) throw new Error("PQ_SIG_SEED is required: 32 bytes hex, e.g. `openssl rand -hex 32`");
  const kemSeed = env.PQ_KEM_SEED;
  if (!kemSeed) throw new Error("PQ_KEM_SEED is required: 64 bytes hex, e.g. `openssl rand -hex 64`");

  const erc8004: { chainId: string; agentId: string }[] = [];
  if (env.ERC8004_HEDERA_AGENT_ID) erc8004.push({ chainId: "296", agentId: env.ERC8004_HEDERA_AGENT_ID });
  if (env.ERC8004_ARC_AGENT_ID) erc8004.push({ chainId: "5042002", agentId: env.ERC8004_ARC_AGENT_ID });

  return {
    port: Number(env.PORT ?? 8787),
    publicUrl: env.PUBLIC_URL ?? "http://localhost:8787",
    sigSeed,
    kemSeed,
    graphApiKey: env.GRAPH_STUDIO_API_KEY ?? "",
    databaseUrl: env.DATABASE_URL ?? null,
    rpc: {
      "1": env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
      "8453": env.BASE_RPC_URL ?? "https://mainnet.base.org",
    },
    hedera: {
      network: "testnet",
      payToAccountId: env.HEDERA_PAYTO_ACCOUNT_ID ?? "",
      operatorId: env.HEDERA_OPERATOR_ID ?? "",
      operatorKey: env.HEDERA_OPERATOR_KEY ?? "",
      facilitatorUrl: env.HEDERA_FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
      usdcToken: env.HEDERA_USDC_TOKEN ?? "0.0.429274",
      hcsTopicId: env.HEDERA_HCS_TOPIC_ID || null,
    },
    arc: {
      sellerAddress: env.ARC_SELLER_ADDRESS ?? "",
      facilitatorUrl: env.ARC_FACILITATOR_URL ?? "https://gateway-api-testnet.circle.com",
      network: "eip155:5042002",
    },
    erc8004,
  };
}
