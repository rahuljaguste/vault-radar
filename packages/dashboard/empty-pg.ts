// Browser stub for the `pg` package.
//
// `@vaultradar/core`'s barrel export (`src/index.ts`) re-exports everything,
// including `src/substreams/reader.ts`, which imports `Pool` from `pg` for a
// server-only Postgres reader. The verify page only needs
// `verifyReceipt`/`receiptHash`/`fromB64` from the same barrel, but bundling
// for the browser still has to resolve every module the barrel touches,
// which pulls `pg` (and transitively Node's `net`/`tls`/`util`) into the
// client build. Nothing in the browser ever calls `Pool`, so it's safe to
// swap in this stub for the browser target — see next.config.ts.
export class Pool {
  constructor() {
    throw new Error("pg.Pool is not available in the browser");
  }
}
const stub = { Pool };
export default stub;
