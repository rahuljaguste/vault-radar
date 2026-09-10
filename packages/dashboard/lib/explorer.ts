/**
 * Block-explorer link helpers. Pure functions — no fetches, no framework
 * dependency — so they're straightforward to unit test.
 */

export type Rail = "hedera" | "arc";

/** The ERC-8004 identity registry contract, deployed at the same address on both testnets. */
const ERC8004_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

/**
 * Hedera transaction ids are `0.0.x@seconds.nanos`. HashScan's URL form
 * replaces the `@` with `-` and the `.` that separates seconds from nanos
 * with `-`, while leaving the dots inside the account id untouched:
 * `0.0.123@1700000000.000000001` -> `0.0.123-1700000000-000000001`.
 */
export function hederaTxIdToHashScanPath(txId: string): string {
  const at = txId.indexOf("@");
  if (at === -1) return txId;
  const accountId = txId.slice(0, at);
  const timestamp = txId.slice(at + 1).replace(".", "-");
  return `${accountId}-${timestamp}`;
}

/** Explorer URL for a paid request's transaction, per rail. */
export function explorerTxUrl(rail: Rail, txId: string): string {
  if (rail === "hedera") {
    return `https://hashscan.io/testnet/transaction/${hederaTxIdToHashScanPath(txId)}`;
  }
  return `https://testnet.arcscan.app/tx/${txId}`;
}

/** Explorer URL for the ERC-8004 registry contract on a given chain, or null if unknown. */
export function erc8004ExplorerUrl(chainId: string): string | null {
  if (chainId === "296") return `https://hashscan.io/testnet/contract/${ERC8004_REGISTRY_ADDRESS}`;
  if (chainId === "5042002") return `https://testnet.arcscan.app/address/${ERC8004_REGISTRY_ADDRESS}`;
  return null;
}
