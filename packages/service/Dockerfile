# The VaultRadar service. Built from the repo root as the Docker context, because the
# service is one workspace package of four and bun resolves the whole workspace from the
# root lockfile.
#
#   docker build -f packages/service/Dockerfile -t vaultradar-service .
#
# There is no build step: every workspace package's entry point is TypeScript source
# (`"main": "src/index.ts"`), and bun runs it directly.

FROM oven/bun:1.3.10

WORKDIR /app

# Manifests before sources, so editing a route does not re-resolve the dependency graph.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/service/package.json packages/service/
COPY packages/agent/package.json packages/agent/
COPY packages/dashboard/package.json packages/dashboard/
RUN bun install --frozen-lockfile

COPY packages ./packages
# Served verbatim at GET /skill.md, read from three levels up from the built file.
COPY skills ./skills

ENV NODE_ENV=production
EXPOSE 8787

# PORT is read from the environment by config.ts; Railway sets it. The banner runs first so
# a container that dies before the server logs anything is distinguishable in the platform's
# logs from one that never started at all; `exec` keeps bun as PID 1 to receive signals.
CMD ["sh", "-c", "echo \"vaultradar: container up (PORT=${PORT:-unset}, PQ_SIG_SEED=${PQ_SIG_SEED:+set})\"; exec bun run packages/service/src/main.ts"]
