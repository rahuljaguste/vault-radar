# The dashboard. Built from the repo root as the Docker context, for the same reason as
# the service image: one workspace package of four, resolved from the root lockfile.
#
#   docker build -f packages/dashboard/Dockerfile -t vaultradar-dashboard .
#
# NEXT_PUBLIC_SERVICE_URL must be set when this image is *built*, not when it runs: Next.js
# inlines NEXT_PUBLIC_* into the client bundle, and /verify fetches the agent card from the
# browser. Build with the deployed service URL or the verify page will look at localhost.
#
# Why the build prefers `node` when the image has one: on Linux, `bun run build` fails with
# "Failed to load external module next/dist/compiled/next-server/app-page-turbo.runtime.prod.js:
# Expected CommonJS module to have a function wrapper. If you weren't messing around with Bun's
# internals, this is a bug in Bun" while collecting page data for /verify. The same build
# succeeds on macOS, so it is bun's Linux CJS loader, not the code. Node runs Next's own
# toolchain without that loader in the way; bun stays the package manager and the fallback.

FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/service/package.json packages/service/
COPY packages/agent/package.json packages/agent/
COPY packages/dashboard/package.json packages/dashboard/
RUN bun install --frozen-lockfile

COPY packages ./packages
# The /docs pages render these files at request time, so the image has to carry them.
COPY docs ./docs
COPY README.md ./README.md

ENV NODE_ENV=production
WORKDIR /app/packages/dashboard
RUN if command -v node >/dev/null 2>&1; then \
      echo "dashboard: building with node $(node --version)"; \
      node ./node_modules/.bin/next build; \
    else \
      echo "dashboard: no node in image, building with bun"; \
      bun run build; \
    fi

EXPOSE 3000
CMD ["sh", "-c", "echo \"dashboard: container up (PORT=${PORT:-unset})\"; if command -v node >/dev/null 2>&1; then exec node ./node_modules/.bin/next start -p ${PORT:-3000}; else exec bun run start -- -p ${PORT:-3000}; fi"]
