import type { ReactNode } from "react";

/**
 * The top of a page: one `<h1>`, an optional lede, optional actions.
 *
 * Seven of the ten pages already opened exactly this way, each writing
 * `<section className="hero"><h1>…</h1><p className="lede">…</p></section>` by hand — and the
 * other three, `/verify`, `/portfolio` and `/admin`, opened with a bare `<h2>` in a plain
 * section. Those three therefore had no `<h1>` at all: a page with no top-level heading for a
 * screen reader to land on, and a shape a visitor reads as a different kind of page from the
 * rest of the site.
 *
 * The lede is capped at `72ch` by `.hero .lede`; body paragraphs under a bare section were
 * not, which is why prose on those same three pages ran to ~118 characters a line.
 */
export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <section className="hero">
      <h1>{title}</h1>
      {lede && <p className="lede">{lede}</p>}
      {actions && <div className="row">{actions}</div>}
    </section>
  );
}
