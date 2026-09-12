### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.env.example`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`
- Modify: `.gitignore` (add `runs/`, `packages/dashboard/.next/`, `substreams/**/target/`)

**Interfaces:**
- Produces: workspace name `@vaultradar/core` importable from sibling packages; `bun test` runs from the root.

- [ ] **Step 1: Root package.json and tsconfig**

```json
{
  "name": "vaultradar",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "bun x tsc -p packages/core/tsconfig.json --noEmit && bun x tsc -p packages/service/tsconfig.json --noEmit && bun x tsc -p packages/agent/tsconfig.json --noEmit",
    "verify-deployments": "bun run scripts/verify-deployments.ts",
    "service": "bun run packages/service/src/main.ts",
    "agent": "bun run packages/agent/src/cli.ts"
  },
  "devDependencies": { "typescript": "^5.6.0", "@types/node": "^22.0.0", "bun-types": "latest" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "resolveJsonModule": true, "types": ["bun-types"], "noEmit": true
  }
}
```

- [ ] **Step 2: Core package**

`packages/core/package.json`:

```json
{
  "name": "@vaultradar/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@noble/post-quantum": "0.7.1",
    "@noble/hashes": "^1.7.0",
    "@noble/ciphers": "^1.2.0",
    "pg": "^8.13.0",
    "viem": "^2.21.0"
  },
  "devDependencies": { "@types/pg": "^8.11.0" }
}
```

`packages/core/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "../../scripts"] }`

`packages/core/src/index.ts`: `export const CORE_VERSION = "0.1.0";`

`packages/core/test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";
import { CORE_VERSION } from "../src/index";
test("core loads", () => { expect(CORE_VERSION).toBe("0.1.0"); });
```

- [ ] **Step 3: .env.example (initial; later tasks append)**

```
# The Graph
GRAPH_STUDIO_API_KEY=
# Substreams sink database (Neon)
DATABASE_URL=
# Chain heads for freshness
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
BASE_RPC_URL=https://mainnet.base.org
```

- [ ] **Step 4: Install and run**

Run: `bun install && bun test`
Expected: `1 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: bun workspace scaffold with core package and test runner"
```

