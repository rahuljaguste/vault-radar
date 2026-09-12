import type { ReactNode } from "react";

export type Series = { t: number; v: number };

/**
 * A share-price series as an inline SVG.
 *
 * SVG rather than a canvas or WebGL on purpose. These are thirty-odd points on one line:
 * a WebGL context would cost a large dependency, force a client component, and put the
 * axis labels into pixels where no screen reader, no test and no text selection can reach
 * them. A polyline scales to any width, renders on the server, inherits the theme's
 * colours, and can be asserted against in a test.
 *
 * The shaded `window` is the point of the whole picture: a flagged drawdown is defined
 * against a *window* (the 24-hour one, say), and showing the series without showing which
 * part of it the flag is about leaves the reader to guess.
 */
export function Sparkline({
  points,
  window,
  tone = "absent",
  label,
  height = 48,
}: {
  points: Series[];
  /** Inclusive time range to shade, e.g. the window a risk flag was computed over. */
  window?: { from: number; to: number };
  tone?: "ok" | "watch" | "alert" | "absent";
  /** Accessible description. Required: a picture of data with no text is unreadable to
   *  anyone not looking at it. */
  label: string;
  height?: number;
}): ReactNode {
  if (points.length < 2) return <p className="faint">Not enough history to plot.</p>;

  // A hair of inset on every side, so the extremes of the series do not sit exactly on the
  // card's border or on the baseline.
  const W = 100;
  const H = 30;
  const PAD_X = 1;
  const PAD_Y = 2;
  const ts = points.map((p) => p.t);
  const vs = points.map((p) => p.v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  // A flat series would divide by zero; give it a band so the line draws mid-height.
  const span = v1 - v0 || Math.abs(v1) || 1;
  const x = (t: number) => (t1 === t0 ? PAD_X : PAD_X + ((t - t0) / (t1 - t0)) * (W - PAD_X * 2));
  const y = (v: number) => H - PAD_Y - ((v - v0) / span) * (H - PAD_Y * 2);

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join(" ");
  const shade =
    window && window.to > t0 && window.from < t1
      ? { x: x(Math.max(window.from, t0)), w: Math.max(x(Math.min(window.to, t1)) - x(Math.max(window.from, t0)), 0.6) }
      : null;

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height }}>
      {shade && <rect className="window" x={shade.x} y={0} width={shade.w} height={H} />}
      <line className="axis" x1={0} y1={H} x2={W} y2={H} vectorEffect="non-scaling-stroke" />
      <path className={`line ${tone}`} d={d} />
    </svg>
  );
}
