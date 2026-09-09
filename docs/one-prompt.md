# One-prompt Substreams generation attempt (Task 11, Step 2)

**Status: skipped.** Per the controller's resolution for Task 11, installing the Substreams
Skills plugin (`claude plugin marketplace add streamingfast/substreams-skills && claude plugin
install substreams-dev@streamingfast-substreams`) was out of scope for this run: it requires
installing a Claude Code plugin, which the task explicitly said not to do. This step is optional
and cheap to redo later, so it was skipped rather than blocking the rest of Task 11 on it.

The scaffold in `substreams/erc4626-vault-metrics/` was instead built by hand, following Steps
3-7 of the task brief directly.

## The prompt, for whoever runs this later

If the Substreams Skills plugin is installed later, this is the exact one-prompt text specified
by the task brief. Run it in a fresh Claude Code session inside `substreams/`, save the output
under version control as `chore(substreams): one-prompt generation (unreviewed)`, and record the
screen:

> Create a Substreams package `erc4626-vault-metrics` for Ethereum mainnet that imports the Pinax
> erc4626 package from
> https://github.com/pinax-network/substreams-evm/raw/main/spkg/erc4626-v0.1.0.spkg, maps its
> Deposit and Withdraw events to a VaultEvent proto with implied share price = assets/shares, and
> emits a SQL sink `db_out` with a `vault_events` table.

## What the hand-built scaffold covers instead

`substreams/erc4626-vault-metrics/` already has a working manifest, protobuf schema, and
`map_vault_events` module (see the Task 11 report for full detail:
`.superpowers/sdd/2026-09-09-vaultradar/task-11-report.md`). Note one concrete finding relevant
to the prompt above: the `sql` sink half of the one-prompt ask (`db_out` / SQL sink) hit a real
blocker independent of any prompt wording. The only available `substreams-sink-sql` protodefs
release, `protodefs-v1.0.7` (Nov 2023), fails `substreams protogen` outright under the current
`substreams` CLI (1.22.0) with a self-contained proto extension conflict, before any package code
is even involved. A one-prompt attempt asking for a `db_out` sink would hit the same wall. Task
13 should build `DatabaseChanges` with the `substreams-database-change` crate (crates.io, v4.x)
instead of importing that spkg.
