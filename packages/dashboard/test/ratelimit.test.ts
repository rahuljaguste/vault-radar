import { expect, test } from "bun:test";
import { DEFAULT_TRUSTED_PROXY_HOPS, RateLimiter, WINDOW_MS, clientKey, scanLimiter, trustedProxyHops } from "../lib/ratelimit";

/** A limiter whose clock the test drives, so nothing here sleeps. */
function fixture(windowMs = WINDOW_MS) {
  let t = 1_000_000;
  const limiter = new RateLimiter(windowMs, () => t);
  return { limiter, advance: (ms: number) => (t += ms) };
}

test("the first call for a key is allowed", () => {
  const { limiter } = fixture();
  expect(limiter.check("1.2.3.4")).toEqual({ allowed: true });
});

test("a second call inside the window is refused with whole seconds to wait", () => {
  const { limiter, advance } = fixture();
  limiter.check("1.2.3.4");
  advance(1_000);
  expect(limiter.check("1.2.3.4")).toEqual({ allowed: false, retryAfterSeconds: 29 });
});

test("retryAfterSeconds rounds up, and never reports zero just before the window closes", () => {
  const { limiter, advance } = fixture();
  limiter.check("k");
  advance(WINDOW_MS - 1);
  expect(limiter.check("k")).toEqual({ allowed: false, retryAfterSeconds: 1 });
});

test("the call exactly on the window boundary is allowed", () => {
  const { limiter, advance } = fixture();
  limiter.check("k");
  advance(WINDOW_MS);
  expect(limiter.check("k")).toEqual({ allowed: true });
});

test("a refused call does not extend the window, so the limit is a rate and not a lockout", () => {
  const { limiter, advance } = fixture();
  limiter.check("k");
  advance(WINDOW_MS - 5_000);
  expect(limiter.check("k").allowed).toBe(false);
  advance(5_000);
  expect(limiter.check("k").allowed).toBe(true);
});

test("keys are independent, so one client cannot rate-limit another", () => {
  const { limiter } = fixture();
  expect(limiter.check("a").allowed).toBe(true);
  expect(limiter.check("b").allowed).toBe(true);
  expect(limiter.check("a").allowed).toBe(false);
});

test("expired keys are swept, so the map does not grow once per client forever", () => {
  const { limiter, advance } = fixture();
  for (let i = 0; i < 50; i++) limiter.check(`client-${i}`);
  expect(limiter.size()).toBe(50);
  advance(WINDOW_MS);
  limiter.check("someone-else");
  expect(limiter.size()).toBe(1);
});

test("the window length is configurable, which is what makes the 30s default testable", () => {
  const { limiter, advance } = fixture(1_000);
  expect(limiter.check("k").allowed).toBe(true);
  advance(999);
  expect(limiter.check("k").allowed).toBe(false);
  advance(1);
  expect(limiter.check("k").allowed).toBe(true);
});

test("reset forgets every recorded call", () => {
  const { limiter } = fixture();
  limiter.check("k");
  limiter.reset();
  expect(limiter.size()).toBe(0);
  expect(limiter.check("k").allowed).toBe(true);
});

test("the exported scan limiter is set to the spec's 30-second window", () => {
  scanLimiter.reset();
  expect(WINDOW_MS).toBe(30_000);
  expect(scanLimiter.check("probe").allowed).toBe(true);
  const second = scanLimiter.check("probe");
  expect(second.allowed).toBe(false);
  if (!second.allowed) expect(second.retryAfterSeconds).toBeLessThanOrEqual(30);
  scanLimiter.reset();
});

/** An environment with a trusted proxy in front, which is the only case where the
 *  forwarded headers mean anything. */
const PROXIED = { TRUST_PROXY: "1" };

test("clientKey takes the entry TRUSTED_PROXY_HOPS from the END, which is the one a caller cannot write", () => {
  // Taking the *first* entry was wrong on any proxy that appends rather than replaces. On
  // Fly.io the client sends whatever it likes and Fly appends the address it actually saw,
  // so the first entry is the client's invention and the last is Fly's observation — which
  // means TRUST_PROXY=1 on Fly still handed out a fresh 30-second window per forged value.
  const forged = "203.0.113.7, 70.41.3.18, 150.172.238.178";
  const req = new Request("http://localhost/api/scan", { headers: { "x-forwarded-for": forged } });
  expect(clientKey(req, PROXIED)).toBe("150.172.238.178");
  expect(clientKey(req, PROXIED)).not.toBe("203.0.113.7");

  // Two appending hops of your own in front: two from the end.
  expect(clientKey(req, { ...PROXIED, TRUSTED_PROXY_HOPS: "2" })).toBe("70.41.3.18");
  expect(clientKey(req, { ...PROXIED, TRUSTED_PROXY_HOPS: "3" })).toBe("203.0.113.7");

  // More hops configured than entries present: the header cannot have come from that chain,
  // so there is no entry to attribute and everyone shares the bucket.
  expect(clientKey(req, { ...PROXIED, TRUSTED_PROXY_HOPS: "4" })).toBe("unknown");
});

test("both real proxy shapes key on the client: Fly appends, Vercel replaces", () => {
  // Fly.io: the client sent "1.1.1.1"; Fly appended the peer address it observed.
  const fly = new Request("http://localhost/", { headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.9" } });
  expect(clientKey(fly, PROXIED)).toBe("198.51.100.9");
  // A caller varying its forged prefix gets the same key every time, so the limiter holds.
  const flyAgain = new Request("http://localhost/", { headers: { "x-forwarded-for": "2.2.2.2, 198.51.100.9" } });
  expect(clientKey(flyAgain, PROXIED)).toBe(clientKey(fly, PROXIED));

  // Vercel: the header is replaced with the address it observed, so there is one entry.
  const vercel = new Request("http://localhost/", { headers: { "x-forwarded-for": "198.51.100.9" } });
  expect(clientKey(vercel, PROXIED)).toBe("198.51.100.9");
  // The default hop count is right for both, which is the point of the default.
  expect(clientKey(vercel, PROXIED)).toBe(clientKey(fly, PROXIED));
});

test("TRUSTED_PROXY_HOPS defaults to 1 and falls back to it for any unusable value", () => {
  expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
  expect(trustedProxyHops({})).toBe(1);
  expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "3" })).toBe(3);
  expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: " 2 " })).toBe(2);
  for (const bad of ["", "  ", "0", "-1", "1.5", "two", "NaN", "Infinity"]) {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: bad })).toBe(1);
  }
});

test("clientKey trims whitespace and falls back to x-real-ip, then to a shared bucket", () => {
  expect(clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": "  198.51.100.9  " } }), PROXIED)).toBe("198.51.100.9");
  expect(clientKey(new Request("http://localhost/", { headers: { "x-real-ip": "198.51.100.10" } }), PROXIED)).toBe("198.51.100.10");
  expect(clientKey(new Request("http://localhost/"), PROXIED)).toBe("unknown");
});

test("an x-forwarded-for that is present but empty falls through rather than keying on an empty string", () => {
  expect(clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": "  ,  " } }), PROXIED)).toBe("unknown");
  expect(clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": " ", "x-real-ip": "10.0.0.1" } }), PROXIED)).toBe("10.0.0.1");
});

test("without TRUST_PROXY every caller shares one bucket, so a forged header buys no extra window", () => {
  // The hole this closes: both candidate headers are set by a proxy and forgeable by
  // anyone talking to the server directly, so keying on them unconditionally gave a
  // fresh 30-second window per distinct value — a per-client limit that refused nothing.
  const forged = (value: string) => new Request("http://localhost/", { headers: { "x-forwarded-for": value } });
  for (const env of [{}, { TRUST_PROXY: "" }, { TRUST_PROXY: "0" }, { TRUST_PROXY: "true" }, { TRUST_PROXY: "yes" }]) {
    expect(clientKey(forged("1.1.1.1"), env)).toBe("unknown");
    expect(clientKey(forged("2.2.2.2"), env)).toBe("unknown");
    expect(clientKey(new Request("http://localhost/", { headers: { "x-real-ip": "3.3.3.3" } }), env)).toBe("unknown");
  }

  // Which means the limiter genuinely limits: a hundred forged addresses get one scan.
  const { limiter } = fixture();
  expect(limiter.check(clientKey(forged("1.1.1.1"), {})).allowed).toBe(true);
  for (let i = 0; i < 100; i++) {
    expect(limiter.check(clientKey(forged(`10.0.0.${i}`), {})).allowed).toBe(false);
  }
  expect(limiter.size()).toBe(1);
});

test("TRUST_PROXY is only honoured as exactly \"1\", with surrounding whitespace tolerated", () => {
  const req = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.7" } });
  expect(clientKey(req, { TRUST_PROXY: " 1 " })).toBe("203.0.113.7");
  expect(clientKey(req, { TRUST_PROXY: "1x" })).toBe("unknown");
});
