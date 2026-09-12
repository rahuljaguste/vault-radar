import { NextResponse } from "next/server";
import { parseIdentityPin } from "@vaultradar/core";

/**
 * `GET /api/expected-identity` returns the operator's pinned ERC-8004 identity, for `/verify`
 * to check a receipt against.
 *
 * Served to the browser from here rather than inlined into the bundle as a `NEXT_PUBLIC_*`
 * value for two reasons: changing the pin should not require rebuilding the image, and one
 * variable name means this route and the paid-scan route cannot disagree about which
 * identity is expected. The value is public — agent ids are on chain — so sending it leaks
 * nothing. What it must never be is derived from the service being verified: it comes from
 * this process's environment, never from the card, the receipt or the registry entry under
 * inspection.
 *
 * No caching config: route handlers are uncached by default, and `force-dynamic` opts a
 * `GET` *into* static caching, which would be the opposite of what this needs. The
 * `no-store` header covers any intermediary between here and the browser.
 */
export function GET(): NextResponse {
  let pins;
  try {
    pins = parseIdentityPin(process.env.EXPECTED_ERC8004);
  } catch (e) {
    // A malformed pin is a misconfiguration the operator has to see. Falling back to "no
    // pins" would turn a typo into a page that claims to have checked something it didn't.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ pins }, { headers: { "cache-control": "no-store" } });
}
