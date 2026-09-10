// Re-exports the pieces `@vaultradar/agent`'s tests need to build the service
// in-process (no network) via `buildApp` + `makeScanHandler`, mirroring how
// `src/main.ts` wires the real process together.
export { buildApp } from "./app";
export { makeScanHandler } from "./handlers/scan";
export type { HandlerDeps } from "./handlers/scan";
export { loadConfig } from "./config";
export type { Config } from "./config";
export { loadKeys } from "./keys";
export type { ServiceKeys } from "./keys";
export { LiveDataProvider } from "./data/provider";
export type { DataProvider, Catalog } from "./data/provider";
// `HcsSink`/`LookupResult` so a test can supply a typed stand-in for the commitment
// queue: `HcsQueue` has private fields, so it cannot be satisfied structurally.
export type { HcsSink, LookupResult } from "./hcs";
