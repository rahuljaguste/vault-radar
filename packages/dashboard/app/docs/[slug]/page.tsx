import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
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
    // One column: the header, the article and the prev/next nav share this measure, so
    // the rule under the heading stops where the prose does.
    <div className="mx-auto flex w-full max-w-[78ch] flex-col gap-10">
      <section className="hero">
        <h1>{doc.title}</h1>
        <div className="row">
          <Button asChild variant="outline" size="sm">
            <Link href="/docs">All documentation</Link>
          </Button>
          <span className="faint mono">{doc.file}</span>
        </div>
      </section>

      {/* The HTML comes from a file in this repository, not from a request: the route takes a
          slug, looks it up in a closed registry, and reads what that names. There is no path
          or content here that a visitor can influence. `prose-invert` because the site has
          one scheme and it is dark. */}
      <article
        className="prose prose-invert max-w-none prose-code:before:content-none prose-code:after:content-none prose-pre:bg-secondary prose-pre:border prose-th:text-muted-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <nav className="row between">
        {prev ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/docs/${prev.slug}`}>← {prev.title}</Link>
          </Button>
        ) : (
          <span />
        )}
        {next ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/docs/${next.slug}`}>{next.title} →</Link>
          </Button>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}
