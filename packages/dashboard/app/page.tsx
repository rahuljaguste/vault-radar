import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table } from "./components/Table";
import { ToneBadge } from "./components/Verdict";
import { Id } from "./components/Id";
import { fetchCard, fetchCatalog, type AgentCard, type CatalogEntry } from "@/lib/service";
import { listRuns, type RunSummary } from "@/lib/runs";
import { erc8004ExplorerUrl } from "@/lib/explorer";

export default async function HomePage() {
  const [card, catalog, runs] = await Promise.all([fetchCard(), fetchCatalog(), listRuns()]);
  // Counts of the registry's own statuses, not of `vaultCount`. That figure is real but
  // nearly always unknowable here: `LiveDataProvider.catalog()` reads it from a per-chain
  // cache with a 60-second TTL that only a paid `scan`/`table` warms, so it is non-zero
  // only inside the minute after somebody buys a scan on that chain and zero at every
  // other moment. Rendering it would put a column of zeroes in front of every visitor,
  // which reads as "this index is empty" — and a dash instead would be a column of dashes,
  // because the window is a minute wide. The registry's statuses say the same thing without
  // lying: they are what `scripts/verify-deployments.ts` actually observed.
  const byStatus = (want: string) => catalog?.protocols.filter((p) => p.status === want).length ?? 0;

  return (
    <>
      <section className="hero">
        <h1>Vault risk, bought one request at a time.</h1>
        <p className="lede">
          VaultRadar sells cross-protocol vault risk over x402, metered per vault, on Hedera and on Arc. Requests are
          sealed with a post-quantum KEM before they leave the buyer, every receipt is signed with ML-DSA-65, and the
          service&rsquo;s signing key is pinned on chain so a forged agent card cannot pass itself off as this one.
        </p>
        <div className="row">
          <Button asChild>
            <Link href="/portfolio">Scan a portfolio</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/verify">Verify a receipt</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/docs/flow">How a request flows</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/admin">Operator metrics</Link>
          </Button>
        </div>
      </section>

      <section className="steps">
        <div>
          <strong>Discover</strong>
          The buyer fetches the agent card, checks its signature, and compares the published key hash against the
          ERC-8004 registry on chain.
        </div>
        <div>
          <strong>Pay</strong>
          A 402 quotes the price for exactly how many vaults were asked about. The buyer checks it against its own
          quote, pays over x402, and the service settles only after a handler answers.
        </div>
        <div>
          <strong>Verify</strong>
          The reply is sealed to the buyer&rsquo;s ephemeral key. The receipt and every per-vault attestation are signed,
          and the receipt hash is committed to Hedera Consensus Service.
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Service</CardTitle>
          <CardDescription>
            {byStatus("live")} live · {byStatus("stale")} stale · {byStatus("down")} down of{" "}
            {catalog?.protocols.length ?? 0} registrations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {card ? <CardSummary card={card} /> : <p className="error">Service unreachable, could not load /.well-known/agent.json.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          {catalog ? (
            <Table<CatalogEntry>
              columns={[
                { key: "protocol", label: "Protocol" },
                { key: "chain", label: "Chain" },
                {
                  key: "status",
                  label: "Status",
                  render: (row) => (
                    <ToneBadge tone={row.status === "live" ? "ok" : row.status === "down" ? "alert" : "unavailable"}>
                      {row.status}
                    </ToneBadge>
                  ),
                },
                // No `vaultCount` column: see the note at the top of this component. It is
                // zero except for the minute after a scan warms that chain's cache, so a
                // "Vaults" column here is a column of zeroes that libels the index.
              ]}
              rows={catalog.protocols}
              rowKey={(row, i) => `${row.protocol}-${row.chain}-${i}`}
              empty="No protocols in the catalog."
            />
          ) : (
            <p className="error">Service unreachable, could not load /v1/catalog.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table<RunSummary>
            columns={[
              {
                key: "id",
                label: "Run",
                render: (row) => <Link href={`/runs/${encodeURIComponent(row.id)}`}>{row.id}</Link>,
              },
              { key: "startedAt", label: "Started at", render: (row) => <span className="num">{row.startedAt}</span> },
              { key: "requestCount", label: "Requests", render: (row) => <span className="num">{row.requestCount}</span> },
            ]}
            rows={runs}
            rowKey={(row) => row.id}
            empty="No runs yet. Buy one from the portfolio page, or run the agent's watch loop."
          />
        </CardContent>
      </Card>
    </>
  );
}

function CardSummary({ card }: { card: AgentCard }) {
  return (
    <dl className="kv">
      <dt>Name</dt>
      <dd>
        {card.name} v{card.version}
      </dd>

      <dt>Summary</dt>
      <dd className="muted">{card.description}</dd>

      <dt>ERC-8004</dt>
      <dd>
        {card.erc8004.length === 0 ? (
          <span className="error">none registered, every paid request will be refused</span>
        ) : (
          card.erc8004.map((e) => {
            const url = erc8004ExplorerUrl(e.chainId);
            return (
              <ToneBadge key={e.chainId} tone="ok">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="no-underline">
                    {e.chainId}:{e.agentId}
                  </a>
                ) : (
                  <>
                    {e.chainId}:{e.agentId}
                  </>
                )}
              </ToneBadge>
            );
          })
        )}
      </dd>

      <dt>Signing key</dt>
      <dd>
        <Id value={card.pq.sig.pub_hash} /> <span className="faint">{card.pq.sig.alg}</span>
      </dd>

      <dt>KEM key</dt>
      <dd>
        <span className="mono">{card.pq.kem.kid}</span> <span className="faint">{card.pq.kem.alg}</span>
      </dd>

      <dt>Prices</dt>
      <dd>
        <span className="num">scan {card.prices.hedera_scan}</span>
        <br />
        <span className="faint">
          table {card.prices.table} · arc buckets s {card.prices.arc_scan_buckets.s} / m {card.prices.arc_scan_buckets.m} / l{" "}
          {card.prices.arc_scan_buckets.l}
        </span>
      </dd>

      <dt>Docs</dt>
      <dd>
        <Link href="/docs">the documentation</Link> <span className="faint">(spec, plan, verification log)</span>
      </dd>

      {/* Two audiences, and this row was conflating them. The card's `docs` field is the
          machine-facing guide a buying agent reads, and it is the only pointer to that file
         , so the human link goes to the documentation site without dropping it. */}
      <dt>Agent guide</dt>
      <dd>
        <a href={card.docs}>skill.md</a> <span className="faint">(the file a buying agent reads, served by the service)</span>
      </dd>
    </dl>
  );
}
