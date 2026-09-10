import { ScanForm } from "./ScanForm";
import { listRuns } from "@/lib/runs";

// Reads the runs directory and the agent-key environment on every request.
export const dynamic = "force-dynamic";

export const metadata = { title: "VaultRadar — scan your portfolio" };

/**
 * Are paid scans possible at all? Only the boolean crosses into the client
 * component; the key values are read here, on the server, and never serialised
 * into the page. Any non-`NEXT_PUBLIC_` variable is also replaced with
 * `undefined` in client bundles by Next.js, so this is belt and braces.
 */
function agentKeysConfigured(): boolean {
  return Boolean(process.env.AGENT_HEDERA_ACCOUNT_ID?.trim() && process.env.AGENT_HEDERA_KEY?.trim());
}

export default async function PortfolioPage() {
  const keysConfigured = agentKeysConfigured();
  // `listRuns` falls back to the bundled demo run when no real runs exist, so the
  // newest entry is always something worth linking to.
  const runs = await listRuns();
  const demoRunId = runs.length > 0 ? runs[runs.length - 1].id : null;

  return (
    <>
      <section>
        <h2>Scan your portfolio</h2>
        <p>
          Paste the vaults you hold. The dashboard buys a risk scan over x402, verifies the ML-DSA-65 receipt and every
          per-vault attestation, applies its own freshness bar to the signed timestamps, and shows one action per vault with
          the evidence behind it.
        </p>
        <p className="muted">
          The payer is the operator&apos;s funded agent account, not a wallet in your browser, so the settlement on the
          explorer is the operator&apos;s. Requests are sealed with a hybrid post-quantum KEM before they leave this server,
          so no intermediary on the path learns which vaults you asked about.
        </p>
      </section>

      <ScanForm keysConfigured={keysConfigured} demoRunId={demoRunId} />
    </>
  );
}
