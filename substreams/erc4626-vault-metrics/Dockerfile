# The ERC-4626 metrics sink: the long-lived process that indexes both chains into Postgres.
#
#   docker build -f substreams/erc4626-vault-metrics/Dockerfile -t vaultradar-sink .
#
# Built from the repo root as the Docker context, because the packed .spkg files it needs live
# next to this file. Build those first: see "Building and packing" in README.md.
#
# One process sinks Ethereum mainnet. `substreams-sink-sql` is a single-binary Go program; the
# package, its schema and the sink all have to agree on the same output-module hash, which the
# setup step below records in the cursors table — so the image always runs setup before run,
# making a restart idempotent.
#
# `--batch-block-flush-interval 10` is not tuning. The default (1,000 blocks) is the interval
# at which the *cursor row* advances while the sink is catching up, and the service reads
# that row to decide whether the sink's data is fresh — so at the default a perfectly healthy
# sink reported a cursor up to 1,000 blocks (3.3 hours) old, and a paid scan of 100 vaults
# came back entirely `stale`. The lag the service sees is finality (64-95 blocks) plus
# whatever the flush interval adds, so the interval is what decides whether freshness is
# reachable at all: at 1,000 it never is, at 50 the measured lag was 121 blocks against a
# 150-block threshold, which is one blip from stale again. Ten blocks — two minutes of
# Ethereum — puts the expected lag at 74-105 blocks and leaves the threshold real headroom.
#
# The DSN is rewritten from `postgresql://` to `postgres://`: the sink's Postgres driver lists
# its allowed schemes as [psql postgres clickhouse parquet] and rejects the longer form that
# managed providers hand out.

FROM debian:bookworm-slim

ARG SINK_VERSION=v4.13.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL "https://github.com/streamingfast/substreams-sink-sql/releases/download/${SINK_VERSION}/substreams-sink-sql_linux_x86_64.tar.gz" \
    | tar -xz -C /usr/local/bin substreams-sink-sql \
 && chmod +x /usr/local/bin/substreams-sink-sql \
 && rm -rf /var/lib/apt/lists/*

COPY substreams/erc4626-vault-metrics/erc4626-vault-metrics-v0.1.0.spkg /pkg/mainnet.spkg

ENV ENDPOINT=mainnet.eth.streamingfast.io:443
# The DSN rewrite is a `case` rather than `sed`: the `#` delimiters of a sed expression do
# not survive this file's own escaping cleanly, and dash (the image's /bin/sh) supports
# neither `${var/x/y}` nor sed's brevity here for free.
CMD ["sh", "-c", "set -e; case \"$DATABASE_URL\" in postgresql://*) DSN=\"postgres://${DATABASE_URL#postgresql://}\";; *) DSN=\"$DATABASE_URL\";; esac; echo \"sink: starting (endpoint=$ENDPOINT)\"; substreams-sink-sql setup \"$DSN\" /pkg/mainnet.spkg --cursors-table cursors_1; exec substreams-sink-sql run \"$DSN\" /pkg/mainnet.spkg -e \"$ENDPOINT\" --params db_out=1 --cursors-table cursors_1 --final-blocks-only --batch-block-flush-interval 10"]
