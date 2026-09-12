import Link from "next/link";
import { notFound } from "next/navigation";
import { DOCS, docBySlug, renderDoc } from "@/lib/docs";

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export const metadata = { title: "VaultRadar — documentation" };

/**
 * One document. Rendered on the server from the file in the repository, so the page cannot
 * disagree with what is committed — including when someone edits the file and forgets that a
 * page exists.
 */
export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = docBySlug(slug);
  if (!doc) notFound();

  const html = renderDoc(doc);
  const index = DOCS.findIndex((d) => d.slug === doc.slug);
  const prev = index > 0 ? DOCS[index - 1] : null;
  const next = index < DOCS.length - 1 ? DOCS[index + 1] : null;

  return (
    <>
      <section className="hero">
        <h1>{doc.title}</h1>
        <div className="row">
          <Link className="cta" href="/docs">
            All documentation
          </Link>
          <span className="faint mono">{doc.file}</span>
        </div>
      </section>

      {/* The HTML comes from a file in this repository, not from a request: the route takes a
          slug, looks it up in a closed registry, and reads what that names. There is no path
          or content here that a visitor can influence. */}
      <article className="doc" dangerouslySetInnerHTML={{ __html: html }} />

      <nav className="row between">
        {prev ? (
          <Link href={`/docs/${prev.slug}`}>← {prev.title}</Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/docs/${next.slug}`}>{next.title} →</Link>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}
