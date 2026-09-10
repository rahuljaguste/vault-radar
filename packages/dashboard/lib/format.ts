/**
 * Display formatting shared by the pages. Nothing here reads the environment or the
 * network, so every function is a pure string transform and testable as one.
 */

/**
 * Unix seconds as a UTC timestamp a person can read.
 *
 * The service reports every instant as seconds since the epoch, which is the right wire
 * format and the wrong thing to put on a screen: an operator comparing "started at"
 * against "checked at" should not have to convert two ten-digit numbers in their head.
 *
 * UTC rather than local time, deliberately. These values are rendered on the server and
 * hydrated in the browser, and a local-time format would produce different text on each
 * side whenever the two disagree about the zone. It also keeps two operators in different
 * places reading the same page the same way, and matches the ISO instants the rest of the
 * app already prints.
 *
 * Anything that is not a plausible epoch is passed through unchanged rather than rendered
 * as "Invalid Date": a value the service formats differently one day should still be
 * legible on the page instead of being replaced by an error string.
 */
export function epochUtc(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value);
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace(".000Z", "Z");
}
