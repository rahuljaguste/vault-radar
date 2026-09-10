import { expect, test } from "bun:test";
import { RateLimiter, WINDOW_MS, clientKey, scanLimiter } from "../lib/ratelimit";

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

test("clientKey takes the first x-forwarded-for entry, which is the original client behind a trusted proxy", () => {
  const req = new Request("http://localhost/api/scan", {
    headers: { "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" },
  });
  expect(clientKey(req)).toBe("203.0.113.7");
});

test("clientKey trims whitespace and falls back to x-real-ip, then to a shared bucket", () => {
  expect(clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": "  198.51.100.9  " } }))).toBe("198.51.100.9");
  expect(clientKey(new Request("http://localhost/", { headers: { "x-real-ip": "198.51.100.10" } }))).toBe("198.51.100.10");
  expect(clientKey(new Request("http://localhost/"))).toBe("unknown");
});

test("an x-forwarded-for that is present but empty falls through rather than keying on an empty string", () => {
  expect(clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": "  ,  " } }))).toBe("unknown");
  expect(clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": " ", "x-real-ip": "10.0.0.1" } }))).toBe("10.0.0.1");
});
