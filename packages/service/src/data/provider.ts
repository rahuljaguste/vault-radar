import type { UnifiedVault, SourceRef } from "@vaultradar/core";

export type Catalog = { protocols: { protocol: string; chain: string; status: string; vaultCount: number }[]; erc4626Chains: string[] };

export interface DataProvider {
  catalog(): Promise<Catalog>;
  scan(vaultIds: string[]): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;
  table(protocol: string, chainId: string): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;
}
