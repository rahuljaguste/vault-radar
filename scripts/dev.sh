#!/usr/bin/env bash
#
# Runs the whole thing locally: the service on 8787 and the dashboard on 3000, with the
# dashboard pointed at the local service rather than at a deployment.
#
#   bash scripts/dev.sh          # both, in the foreground, ctrl-c to stop
#
# Why this exists rather than two terminals: the dashboard reads SERVICE_URL, and a .env
# written for the deployed stack points it at Railway — so starting both by hand usually
# shows you the deployed service's data from a local page, which is a confusing way to
# develop. This overrides it for the child processes only.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "no .env — copy .env.example and fill it in first:" >&2
  echo "  cp .env.example .env" >&2
  exit 1
fi
if ! grep -q '^PQ_SIG_SEED=[0-9a-f]' .env; then
  echo "PQ_SIG_SEED is unset (or still the placeholder). The service refuses to start without it:" >&2
  echo "  echo \"PQ_SIG_SEED=\$(openssl rand -hex 32)\" >> .env" >&2
  echo "  echo \"PQ_KEM_SEED=\$(openssl rand -hex 64)\" >> .env" >&2
  exit 1
fi

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

echo "service    http://localhost:8787"
bun run packages/service/src/main.ts &
pids+=($!)

# The dashboard needs a public service URL at build time for /verify to reach it from the
# browser, which is why this is exported rather than left to .env.
echo "dashboard  http://localhost:3000"
SERVICE_URL=http://localhost:8787 \
NEXT_PUBLIC_SERVICE_URL=http://localhost:8787 \
RUNS_DIR=runs \
  bun run --cwd packages/dashboard dev &
pids+=($!)

wait -n
