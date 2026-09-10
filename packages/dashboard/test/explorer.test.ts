import { expect, test } from "bun:test";
import { hederaTxIdToHashScanPath, explorerTxUrl, erc8004ExplorerUrl } from "../lib/explorer";

test("converts a Hedera tx id to HashScan's dash form, leaving account-id dots alone", () => {
  expect(hederaTxIdToHashScanPath("0.0.123@1700000000.000000001")).toBe("0.0.123-1700000000-000000001");
});

test("returns the input unchanged when there is no @ (not a Hedera tx id)", () => {
  expect(hederaTxIdToHashScanPath("not-a-tx-id")).toBe("not-a-tx-id");
});

test("builds a HashScan transaction URL for the hedera rail", () => {
  expect(explorerTxUrl("hedera", "0.0.123@1700000000.000000001")).toBe(
    "https://hashscan.io/testnet/transaction/0.0.123-1700000000-000000001"
  );
});

test("builds an Arcscan transaction URL for the arc rail", () => {
  expect(explorerTxUrl("arc", "0xabc123")).toBe("https://testnet.arcscan.app/tx/0xabc123");
});

test("links the ERC-8004 registry contract per chain", () => {
  expect(erc8004ExplorerUrl("296")).toBe("https://hashscan.io/testnet/contract/0x8004A818BFB912233c491871b3d84c89A494BD9e");
  expect(erc8004ExplorerUrl("5042002")).toBe("https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e");
  expect(erc8004ExplorerUrl("1")).toBeNull();
});
