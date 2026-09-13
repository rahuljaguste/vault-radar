import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DOCS } from "@/lib/docs";

export const metadata = { title: "VaultRadar: documentation" };

export default function DocsIndex() {
  return (
    <>
      <section className="hero">
        <h1>Documentation</h1>
        <p className="lede">
          The repository&rsquo;s own prose, rendered here rather than left to a reader who would have to clone it. Every
          page below is the file itself, the spec the implementation was held to, the plan it was built from, the log
          of what was verified against the deployed system, and the record of how the work was directed.
        </p>
      </section>

      <section className="grid">
        {/* Not in `DOCS`, because that registry is file-backed and this page is a walkthrough
            rather than a document: it renders the animated payment flow, not markdown. It sits
            first anyway, because it is the one thing here a newcomer should look at before the
            spec or the plan. Labelled `walkthrough` rather than given a filename, so the lede's
            claim that every document below is the file itself stays true. */}
        <Link href="/docs/flow" className="no-underline">
          <Card className="h-full transition-colors hover:border-brand/50">
            <CardHeader>
              <CardTitle>How one request flows</CardTitle>
              <CardDescription>
                Eight steps of the x402 round trip, animated, with the checks each side performs between messages.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="faint mono">walkthrough</p>
            </CardContent>
          </Card>
        </Link>
        {DOCS.map((d) => (
          <Link key={d.slug} href={`/docs/${d.slug}`} className="no-underline">
            <Card className="h-full transition-colors hover:border-brand/50">
              <CardHeader>
                <CardTitle>{d.title}</CardTitle>
                <CardDescription>{d.summary}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="faint mono">{d.file}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
    </>
  );
}
