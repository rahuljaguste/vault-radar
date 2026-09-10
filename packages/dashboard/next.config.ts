import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@vaultradar/core`'s single barrel export drags in `pg` (used only by its
  // server-only substreams reader) for any client-side import from the
  // package, e.g. the /verify page's use of verifyReceipt/receiptHash/fromB64.
  // `pg` needs Node's net/tls/util, which don't exist in the browser, so swap
  // in an empty stub for the browser target only — server bundles still get
  // the real thing (and Next already treats `pg` as server-external anyway).
  turbopack: {
    resolveAlias: {
      pg: { browser: "./empty-pg.ts" },
    },
  },
};

export default nextConfig;
