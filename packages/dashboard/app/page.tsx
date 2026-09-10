import Link from "next/link";
import { Table } from "./components/Table";
import { fetchCard, fetchCatalog, type AgentCard, type CatalogEntry } from "@/lib/service";
import { listRuns, type RunSummary } from "@/lib/runs";
import { erc8004ExplorerUrl } from "@/lib/explorer";

export default async function HomePage() {
  const [card, catalog, runs] = await Promise.all([fetchCard(), fetchCatalog(), listRuns()]);

  return (
    <>
      <section>
        <h2>Agent card</h2>
        {card ? <CardSummary card={card} /> : <p className="error">Service unreachable — could not load /.well-known/agent.json.</p>}
      </section>

      <section>
        <h2>Catalog</h2>
        {catalog ? (
          <Table<CatalogEntry>
            columns={[
              { key: "protocol", label: "Protocol" },
              { key: "chain", label: "Chain" },
              { key: "status", label: "Status" },
              { key: "vaultCount", label: "Vaults" },
            ]}
            rows={catalog.protocols}
            rowKey={(row, i) => `${row.protocol}-${row.chain}-${i}`}
            empty="No protocols in the catalog."
          />
        ) : (
          <p className="error">Service unreachable — could not load /v1/catalog.</p>
        )}
      </section>

      <section>
        <h2>Runs</h2>
        <Table<RunSummary>
          columns={[
            {
              key: "id",
              label: "Run",
              render: (row) => <Link href={`/runs/${encodeURIComponent(row.id)}`}>{row.id}</Link>,
            },
            { key: "startedAt", label: "Started at" },
            { key: "requestCount", label: "Requests" },
          ]}
          rows={runs}
          rowKey={(row) => row.id}
          empty="No runs yet."
        />
      </section>
    </>
  );
}

function CardSummary({ card }: { card: AgentCard }) {
  return (
    <dl>
      <dt>Name</dt>
      <dd>
        {card.name} v{card.version} — {card.description}
      </dd>

      <dt>ERC-8004</dt>
      <dd>
        {card.erc8004.length === 0 && "none registered"}
        {card.erc8004.map((e) => {
          const url = erc8004ExplorerUrl(e.chainId);
          return (
            <span key={e.chainId} className="pill">
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {e.chainId}:{e.agentId}
                </a>
              ) : (
                <>
                  {e.chainId}:{e.agentId}
                </>
              )}
            </span>
          );
        })}
      </dd>

      <dt>PQ keys</dt>
      <dd>
        sig {card.pq.sig.alg} pub_hash <code>{card.pq.sig.pub_hash}</code>
        <br />
        kem {card.pq.kem.alg} kid <code>{card.pq.kem.kid}</code>
      </dd>

      <dt>Prices</dt>
      <dd>
        Hedera scan: {card.prices.hedera_scan} (1 vault = {card.prices.hedera_scan_examples["1"]}, 10 vaults = {card.prices.hedera_scan_examples["10"]})
        <br />
        Arc scan buckets: S {card.prices.arc_scan_buckets.s}, M {card.prices.arc_scan_buckets.m}, L {card.prices.arc_scan_buckets.l}
        <br />
        Table: {card.prices.table}
      </dd>

      <dt>Docs</dt>
      <dd>
        <a href={card.docs}>{card.docs}</a>
      </dd>
    </dl>
  );
}
