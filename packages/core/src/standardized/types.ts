export type Deployment = {
  protocol: string;
  chain: string;
  chainId: string;
  schema: "yield-aggregator" | "lending";
  subgraphId: string;
  deploymentId: string | null;
  status: "live" | "stale" | "down" | "unverified";
  headLagSeconds: number | null;
  verifiedAt: string | null;
};
