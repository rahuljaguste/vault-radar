import { ScanForm } from "./ScanForm";
import { PageHeader } from "@/app/components/PageHeader";
import { listRuns } from "@/lib/runs";
import { microToUsd, scanSpendLedger } from "@/lib/spend";

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
  // The aggregate cap every purchase from this page is checked against. Read on the server
  // from the same process-wide ledger `POST /api/scan` uses, so the figure shown is the one
  // that will actually be enforced. Only the formatted amounts cross to the client.
  const spend = scanSpendLedger().snapshot();

  return (
    <>
      <PageHeader
        title="Scan your portfolio"
        lede={
          <>
            Paste the vaults you hold. The dashboard buys a risk scan over x402, verifies the ML-DSA-65 receipt and every
            per-vault attestation, and shows one action per vault with the evidence behind it. The payer is the
            operator&apos;s funded agent account, not a wallet in your browser, and requests are sealed before they leave
            this server — so no intermediary on the path learns which vaults you asked about.
          </>
        }
      />

      <section>
        <h2>Spending allowance</h2>
        <dl>
          <dt>Spent today</dt>
          <dd>
            {microToUsd(spend.spentMicroUsd)} of {microToUsd(spend.capMicroUsd)} USD
          </dd>
          <dt>Scans this hour</dt>
          <dd>
            {spend.scansLastHour} of {spend.maxScansPerHour}
          </dd>
        </dl>
        <p className="muted">
          Both limits are shared by everyone using this dashboard and cover a rolling window, not a calendar day. A scan
          that would take the total past the cap is refused before anything is paid. The counters live in this server
          process, so a restart resets them.
        </p>
      </section>

      <ScanForm keysConfigured={keysConfigured} demoRunId={demoRunId} />
    </>
  );
}
