import { readFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { repoRoot } from "./runs";

/**
 * The repository's prose, rendered as pages rather than left as files.
 *
 * The documents already exist and are the source of truth: the README, the architecture
 * note, the verification log, the standards write-up, and the AI-workflow record with its
 * spec and plan. Duplicating any of them into JSX would guarantee they drift, so these
 * pages render the files themselves.
 *
 * `DOCS` is a closed registry. Nothing takes a path from the request — a page looks up a
 * slug in this map and reads what the map names, which is why the route can read from disk
 * without a traversal to worry about.
 */

export type Doc = { slug: string; title: string; summary: string; file: string };

export const DOCS: Doc[] = [
  {
    slug: "overview",
    title: "Overview",
    summary: "What VaultRadar is, how a request is paid for, and what is deployed right now.",
    file: "README.md",
  },
  {
    slug: "architecture",
    title: "Architecture",
    summary: "The system view and the flow of one paid request, with the rendered diagrams.",
    file: "docs/architecture.md",
  },
  {
    slug: "verification",
    title: "Verification log",
    summary: "What was checked against the deployed system, what came back, and how to check it yourself.",
    file: "docs/verification-log.md",
  },
  {
    slug: "standards",
    title: "What the standards made easier",
    summary: "The write-up for judges: the Graph, Hedera and Arc standards the project leans on.",
    file: "docs/standards-leverage.md",
  },
  {
    slug: "one-prompt",
    title: "The one-prompt experiment",
    summary: "A single-prompt Substreams generation attempt that was deliberately not run, with the prompt and the reasoning.",
    file: "docs/one-prompt.md",
  },
  {
    slug: "ai-workflow",
    title: "How this was built",
    summary: "The AI workflow, the attribution, and what the review process actually caught.",
    file: "docs/ai-workflow/README.md",
  },
  {
    slug: "direction",
    title: "The direction, in order",
    summary: "The prompts that drove the project, in sequence, with what each one produced.",
    file: "docs/ai-workflow/direction.md",
  },
  {
    slug: "license",
    title: "License",
    summary: "MIT.",
    file: "LICENSE",
  },
  {
    slug: "spec",
    title: "Design spec",
    summary: "The binding specification the implementation was held to.",
    file: "docs/superpowers/specs/2026-09-05-vaultradar-design.md",
  },
  {
    slug: "plan",
    title: "Implementation plan",
    summary: "The 29-task plan, with the verified API facts each task was built against.",
    file: "docs/superpowers/plans/2026-09-09-vaultradar.md",
  },
];

export const docBySlug = (slug: string): Doc | undefined => DOCS.find((d) => d.slug === slug);

/**
 * Where a link in a document should point on this site.
 *
 * The files cross-reference each other by path (`docs/verification-log.md`,
 * `../superpowers/specs/x.md`), which is right in a repository and wrong on a page. Anything
 * that is not another document or a bundled asset is left exactly as it was: external links
 * and in-page anchors must not be rewritten.
 */
export function rewriteHref(href: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [target, hash = ""] = href.split("#");
  const suffix = hash ? `#${hash}` : "";
  const base = path.posix.basename(target ?? "");

  const asDoc = DOCS.find((d) => d.file === target || path.posix.basename(d.file) === base);
  if (asDoc) return `/docs/${asDoc.slug}${suffix}`;

  // Images and other assets ship under `public/docs-assets/` (the Dockerfile copies them
  // there), because the Markdown refers to them relative to the file that mentions them.
  if (/\.(png|jpg|jpeg|svg|gif|webp)$/i.test(target ?? "")) return `/docs-assets/${base}${suffix}`;
  return href;
}

/** Renders one document to HTML, with its cross-links pointed at this site's routes. */
export function renderDoc(doc: Doc): string {
  const source = readFileSync(path.join(repoRoot(), doc.file), "utf8");
  const html = marked.parse(source, { async: false, gfm: true }) as string;
  // Rewriting the rendered attributes rather than the Markdown keeps this from having to
  // understand Markdown at all — and it cannot corrupt a code block, because those are
  // already escaped by the renderer.
  return html.replace(/(href|src)="([^"]+)"/g, (_m, attr: string, value: string) => `${attr}="${rewriteHref(value)}"`);
}
