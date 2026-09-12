import Link from "next/link";
import { DOCS } from "@/lib/docs";

export const metadata = { title: "VaultRadar — documentation" };

export default function DocsIndex() {
  return (
    <>
      <section className="hero">
        <h1>Documentation</h1>
        <p className="lede">
          The repository&rsquo;s own prose, rendered here rather than left to a reader who would have to clone it. Every
          page below is the file itself — the spec the implementation was held to, the plan it was built from, the log
          of what was verified against the deployed system, and the record of how the work was directed.
        </p>
      </section>

      <section className="grid">
        {DOCS.map((d) => (
          <Link key={d.slug} href={`/docs/${d.slug}`} className="card" style={{ textDecoration: "none" }}>
            <h3>{d.title}</h3>
            <p className="faint">{d.summary}</p>
            <p className="faint mono">{d.file}</p>
          </Link>
        ))}
      </section>
    </>
  );
}
