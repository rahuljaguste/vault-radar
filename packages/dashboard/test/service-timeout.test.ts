import { afterEach, expect, test } from "bun:test";
import { SERVICE_FETCH_TIMEOUT_MS, fetchCard, fetchCatalog, fetchReceiptLookup } from "../lib/service";

/**
 * Every `lib/service.ts` fetch is made by a server component rendering a page, and `fetch`
 * has no default timeout: a service that accepts the connection and never answers used to
 * hold the render open until the platform's own (much longer) limit. These drive the real
 * functions against a server that never responds, with the timeout shortened by monkeying
 * the global clock's patience rather than by waiting ten seconds.
 */

const savedUrl = process.env.SERVICE_URL;

afterEach(() => {
  if (savedUrl === undefined) delete process.env.SERVICE_URL;
  else process.env.SERVICE_URL = savedUrl;
});

test("the timeout is the documented ten seconds", () => {
  expect(SERVICE_FETCH_TIMEOUT_MS).toBe(10_000);
});

test("a service that accepts the connection and never answers is abandoned, not waited on", async () => {
  // Never writes a response and holds the socket open — the case a plain `fetch` waits on
  // until the platform kills the render. The timeout is shortened here so the abort fires
  // inside the test; production uses `SERVICE_FETCH_TIMEOUT_MS`, asserted above.
  const hung = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
  process.env.SERVICE_URL = `http://127.0.0.1:${hung.port}`;
  try {
    const started = Date.now();
    // Without the AbortController this never settles and the test times out instead.
    expect(await fetchCard(150)).toBeNull();
    expect(await fetchCatalog(150)).toBeNull();
    expect(await fetchReceiptLookup("ab".repeat(32), 150)).toBeNull();
    // Bounded by the timeout, not by the server: three abandoned requests in well under a
    // second, against a server that answered none of them.
    expect(Date.now() - started).toBeLessThan(3_000);
  } finally {
    // Not awaited: the handler promise above never resolves, and both `stop()` and
    // `stop(true)` wait on in-flight requests, so awaiting either one hangs forever.
    // `unref` lets the test process exit with the listener still open.
    hung.unref();
    void hung.stop(true);
  }
}, 10_000);

test("an aborted fetch is reported as an unreachable service, not as a thrown error", async () => {
  // The abort path has to be indistinguishable from any other failure to reach the service,
  // because that is what every caller renders. Driven by a server that closes the
  // connection, which surfaces through the same `catch`.
  const closing = Bun.serve({ port: 0, fetch: () => { throw new Error("no"); } });
  const port = closing.port;
  await closing.stop(true);
  process.env.SERVICE_URL = `http://127.0.0.1:${port}`;
  expect(await fetchCard()).toBeNull();
  expect(await fetchCatalog()).toBeNull();
  expect(await fetchReceiptLookup("ab".repeat(32))).toBeNull();
});

test("a non-ok response is null, and a good one is parsed", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname === "/v1/catalog") return Response.json({ protocols: [], erc4626Chains: ["1"] });
      return new Response("nope", { status: 503 });
    },
  });
  process.env.SERVICE_URL = `http://127.0.0.1:${srv.port}`;
  try {
    expect(await fetchCatalog()).toEqual({ protocols: [], erc4626Chains: ["1"] });
    expect(await fetchCard()).toBeNull();
  } finally {
    await srv.stop(true);
  }
});
