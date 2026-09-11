export type Deployment = {
  protocol: string;
  chain: string;
  chainId: string;
  schema: "yield-aggregator" | "lending";
  subgraphId: string;
  deploymentId: string | null;
  /**
   * `live` / `stale` / `down` describe the pinned deployment's indexing head; `unverified`
   * means the gate has never run against it.
   *
   * `repointed` means the subgraph id now resolves to a *different* deployment than the one
   * `deploymentId` pins. Queries keep going to the pinned deployment, which is the whole
   * point of pinning — so this is a flag for the operator (the publisher has rolled a new
   * version; decide whether to follow), not a failure, and `fetchStandardized` still reads
   * it. Set only by `scripts/verify-deployments.ts`, which never overwrites a pinned id.
   */
  status: "live" | "stale" | "down" | "unverified" | "repointed";
  headLagSeconds: number | null;
  verifiedAt: string | null;
};
