import { expect, test } from "bun:test";
import { DOCS, docBySlug, renderDoc, rewriteHref } from "../lib/docs";

test("every registered document exists and renders, so a page cannot 404 for a missing file", () => {
  expect(DOCS.length).toBeGreaterThan(0);
  for (const doc of DOCS) {
    const html = renderDoc(doc);
    expect(html.length).toBeGreaterThan(200);
    expect(docBySlug(doc.slug)).toBe(doc);
  }
});

test("an unknown slug resolves to nothing rather than a path", () => {
  // The route looks slugs up in a closed registry and reads what it names. Nothing a request
  // carries reaches the filesystem, which is what makes reading from disk safe here.
  expect(docBySlug("../../etc/passwd")).toBeUndefined();
  expect(docBySlug("nope")).toBeUndefined();
});

test("links to another document become that document's page", () => {
  expect(rewriteHref("docs/architecture.md")).toBe("/docs/architecture");
  expect(rewriteHref("README.md")).toBe("/docs/overview");
  // How the docs link to each other from a sibling directory.
  expect(rewriteHref("../superpowers/specs/2026-09-05-vaultradar-design.md")).toBe("/docs/spec");
  expect(rewriteHref("../superpowers/plans/2026-09-09-vaultradar.md")).toBe("/docs/plan");
  // A fragment on a document link survives the rewrite.
  expect(rewriteHref("docs/architecture.md#system-view")).toBe("/docs/architecture#system-view");
});

test("assets move to the path the images are actually served from", () => {
  expect(rewriteHref("docs/architecture.png")).toBe("/docs-assets/architecture.png");
  expect(rewriteHref("architecture.png")).toBe("/docs-assets/architecture.png");
  expect(rewriteHref("payment-flow.png")).toBe("/docs-assets/payment-flow.png");
});

// The rewriting runs over the rendered HTML, so an over-eager rule would corrupt external
// links and in-page anchors, which are the majority of the links in these documents.
test("links that are not documents or assets are left exactly as they were", () => {
  for (const href of [
    "https://hashscan.io/testnet/transaction/0.0.7162784-1789169558-289173297",
    "https://thegraph.market",
    "#what-is-here",
    "mailto:someone@example.com",
    "packages/core/src/standardized/templates.ts",
    "runs/2026-09-12T01-13-26.063Z-web-25410467b576.json",
  ]) {
    expect(rewriteHref(href)).toBe(href);
  }
});

test("rendered documents carry no link back into the repository's file layout", () => {
  for (const doc of DOCS) {
    const html = renderDoc(doc);
    const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      // Anything relative would resolve against the page's URL and 404 — which is the whole
      // failure this rewriting exists to prevent.
      if (/^(https?:|mailto:|#|\/)/.test(href)) continue;
      const isAsset = href.endsWith(".png") || href.endsWith(".svg");
      throw new Error(`${doc.slug}: ${href} was left relative${isAsset ? " (asset)" : ""}`);
    }
  }
});
