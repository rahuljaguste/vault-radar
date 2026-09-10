import { expect, test } from "bun:test";
import { formatUsdc, hederaUsdcBalance, readBalances, readHealth } from "../src/balances";

/** A fetch stub that records every URL it was asked for and answers from a route table. */
function stubFetch(routes: Record<string, { status: number; body?: unknown }>): { f: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    // Longest matching prefix wins, so a route for an API root can't shadow a route
    // for a path under it.
    const hit = Object.entries(routes)
      .filter(([prefix]) => url.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return new Response("not found", { status: 404 });
    const [, r] = hit;
    return new Response(r.body == null ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { f, urls };
}

test("formatUsdc renders 6-decimal atomic units without losing low-order digits", () => {
  expect(formatUsdc("0")).toBe("0");
  expect(formatUsdc("1")).toBe("0.000001");
  expect(formatUsdc("1500")).toBe("0.0015");
  expect(formatUsdc("1000000")).toBe("1");
  expect(formatUsdc("12345678")).toBe("12.345678");
  // Well past Number.MAX_SAFE_INTEGER: string arithmetic keeps every digit.
  expect(formatUsdc("90071992547409910000001")).toBe("90071992547409910.000001");
  expect(formatUsdc("not-a-number")).toBe("0");
});

test("hederaUsdcBalance reads tokens[0].balance off the mirror node and converts it", async () => {
  const { f, urls } = stubFetch({
    "https://mirror.test/api/v1/accounts": { status: 200, body: { tokens: [{ token_id: "0.0.429274", balance: 2500000 }] } },
  });
  expect(await hederaUsdcBalance("0.0.1234", { fetchImpl: f, mirrorUrl: "https://mirror.test" })).toBe("2.5");
  expect(urls[0]).toBe("https://mirror.test/api/v1/accounts/0.0.1234/tokens?token.id=0.0.429274");
});

test("an account that never held the token, a mirror-node error, and an unreachable mirror all read as zero", async () => {
  const empty = stubFetch({ "https://mirror.test": { status: 200, body: { tokens: [] } } });
  expect(await hederaUsdcBalance("0.0.1", { fetchImpl: empty.f, mirrorUrl: "https://mirror.test" })).toBe("0");

  const broken = stubFetch({ "https://mirror.test": { status: 500, body: { _status: "oops" } } });
  expect(await hederaUsdcBalance("0.0.1", { fetchImpl: broken.f, mirrorUrl: "https://mirror.test" })).toBe("0");

  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await hederaUsdcBalance("0.0.1", { fetchImpl: down, mirrorUrl: "https://mirror.test" })).toBe("0");
});

test("readBalances reports zero for a rail with no wallet configured and never calls its probe", async () => {
  const { f } = stubFetch({ "https://mirror.test": { status: 200, body: { tokens: [{ balance: 1000000 }] } } });
  let arcCalls = 0;
  const both = await readBalances({
    fetchImpl: f,
    mirrorUrl: "https://mirror.test",
    hederaAccountId: "0.0.1",
    arcPrivateKey: ("0x" + "22".repeat(32)) as `0x${string}`,
    arcBalance: async () => {
      arcCalls += 1;
      return "4.20";
    },
  });
  expect(both).toEqual({ hedera: "1", arc: "4.20" });
  expect(arcCalls).toBe(1);

  const hederaOnly = await readBalances({
    fetchImpl: f,
    mirrorUrl: "https://mirror.test",
    hederaAccountId: "0.0.1",
    arcPrivateKey: null,
    arcBalance: async () => {
      arcCalls += 1;
      return "4.20";
    },
  });
  expect(hederaOnly).toEqual({ hedera: "1", arc: "0" });
  expect(arcCalls).toBe(1); // the Arc probe was not reached at all
});

test("readHealth requires 2xx from the service, the Hedera facilitator and Circle Gateway", async () => {
  const { f, urls } = stubFetch({
    "https://svc.test/health": { status: 200, body: { ok: true, kid: "k", pubHash: "p" } },
    "https://blocky.test/supported": { status: 200, body: { kinds: [] } },
    "https://gateway.test/v1/x402/supported": { status: 200, body: { kinds: [] } },
  });
  const h = await readHealth({ fetchImpl: f, serviceUrl: "https://svc.test", facilitatorUrl: "https://blocky.test", gatewayUrl: "https://gateway.test" });
  expect(h).toEqual({ service: true, hedera: true, arc: true, notes: [] });
  expect(urls).toEqual([
    "https://svc.test/health",
    "https://blocky.test/supported",
    "https://gateway.test/v1/x402/supported",
  ]);
});

test("a non-2xx facilitator, and a service answering ok:false, are unhealthy with a note each", async () => {
  const { f } = stubFetch({
    "https://svc.test/health": { status: 200, body: { ok: false } },
    "https://blocky.test/supported": { status: 503, body: { error: "down" } },
    "https://gateway.test/v1/x402/supported": { status: 200, body: {} },
  });
  const h = await readHealth({ fetchImpl: f, serviceUrl: "https://svc.test", facilitatorUrl: "https://blocky.test", gatewayUrl: "https://gateway.test" });
  expect(h.service).toBe(false);
  expect(h.hedera).toBe(false);
  expect(h.arc).toBe(true);
  expect(h.notes.join(" ")).toContain("/health did not answer ok");
  expect(h.notes.join(" ")).toContain("/supported did not answer 2xx");
});

test("a 404 on Gateway's x402 support path falls back to the API root and says so", async () => {
  const { f, urls } = stubFetch({
    "https://svc.test/health": { status: 200, body: { ok: true } },
    "https://blocky.test/supported": { status: 200, body: {} },
    // The documented x402 support path is gone, but the API root is up.
    "https://gateway.test/v1/x402/supported": { status: 404, body: { error: "not found" } },
    "https://gateway.test": { status: 200, body: { service: "gateway" } },
  });
  const h = await readHealth({ fetchImpl: f, serviceUrl: "https://svc.test", facilitatorUrl: "https://blocky.test", gatewayUrl: "https://gateway.test" });
  expect(h.arc).toBe(true);
  expect(h.notes.join(" ")).toContain("returned 404");
  expect(urls).toContain("https://gateway.test/v1/x402/supported");
  expect(urls).toContain("https://gateway.test");
});
