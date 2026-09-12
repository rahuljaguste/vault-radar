"use client";

import { useState, type ReactNode } from "react";

/**
 * Abbreviates an identifier for display: `0xabc000…aaa`.
 *
 * The full value is what a reader needs to *check* something, and the abbreviated form is
 * what they need to *read* a page. Showing only the long form wraps table cells into
 * ribbons of hex; showing only the short form makes the page uncopyable.
 */
export function shorten(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * An identifier: abbreviated on screen, complete in the tooltip and one click away from the
 * clipboard. Client-side only because of the copy button — the value itself renders on the
 * server, so the page is still readable and testable without JavaScript.
 */
export function Id({
  value,
  href,
  display,
  head,
  tail,
}: {
  value: string;
  /** Where the full identifier can be seen, when it is a transaction. */
  href?: string;
  /** Override the abbreviated form, e.g. to keep a chain prefix intact. */
  display?: string;
  head?: number;
  tail?: number;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const shown = display ?? shorten(value, head, tail);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access denied (insecure context, or a browser that refuses without a
      // gesture). The value is in the title either way, so this is not worth an error.
    }
  }

  return (
    <span className="id">
      {href ? (
        <a className="mono" href={href} title={value} target="_blank" rel="noreferrer">
          {shown}
        </a>
      ) : (
        <span className="mono" title={value}>
          {shown}
        </span>
      )}
      <button className="copy" onClick={copy} title={`copy ${value}`} aria-label={`copy ${value}`} type="button">
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
