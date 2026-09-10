import { handleScan } from "@/lib/scan";

// Spends money and reads secrets from the environment on every call.
export const dynamic = "force-dynamic";

/**
 * `POST /api/scan` with `{ "vaults": ["<chainId>:0x<40 hex address>", ...] }`
 * buys one sealed x402 scan and returns
 * `{ runId, requests, decisions, txId, receiptHash, priceUsd }`.
 *
 * `503` when the agent keys are not configured, `400` on a bad vault list,
 * `429` when rate-limited, `502` when the service cannot be verified or paid.
 * The whole implementation is in `lib/scan.ts` so its dependencies can be
 * injected by `test/scan.test.ts`.
 */
export function POST(req: Request): Promise<Response> {
  return handleScan(req);
}
