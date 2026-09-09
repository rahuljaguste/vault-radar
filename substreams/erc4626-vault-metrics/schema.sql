-- Schema for the erc4626-vault-metrics Substreams SQL sink (db_out module).
--
-- vault_metrics: one row per (vault, block) the vault had activity in this run -- an append-only
-- history table. vault_latest: one row per vault, upserted to the most recent metrics snapshot --
-- what a dashboard should query for "current" values. vault_meta: one row per vault, written once
-- (store_vault_meta is set_if_not_exists) with the ERC-4626 asset/decimals metadata.
--
-- NUMERIC (not BIGINT) is used for asset/share amounts and prices because they arrive from the
-- Substreams module as arbitrary-precision decimal strings (18-decimal fixed-point for
-- share_price, raw token base units for the rest) that can exceed BIGINT's 64-bit range for
-- high-supply/low-decimal tokens. total_assets/total_supply are nullable: db_out only sets them
-- when map_vault_metrics sourced the row from an eth_call (share_price_source = 'call'); event-
-- sourced rows leave them NULL rather than writing an empty string.

CREATE TABLE IF NOT EXISTS vault_metrics (
  chain_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  block BIGINT NOT NULL,
  timestamp BIGINT NOT NULL,
  share_price NUMERIC NOT NULL,
  share_price_source TEXT NOT NULL,
  total_assets NUMERIC,
  total_supply NUMERIC,
  net_deposited_assets NUMERIC,
  net_flow_assets NUMERIC,
  depositor_count BIGINT,
  last_event_block BIGINT,
  PRIMARY KEY (chain_id, vault, block)
);

CREATE TABLE IF NOT EXISTS vault_latest (
  chain_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  block BIGINT NOT NULL,
  timestamp BIGINT NOT NULL,
  share_price NUMERIC NOT NULL,
  total_assets NUMERIC,
  total_supply NUMERIC,
  net_deposited_assets NUMERIC,
  depositor_count BIGINT,
  last_event_block BIGINT,
  PRIMARY KEY (chain_id, vault)
);

CREATE TABLE IF NOT EXISTS vault_meta (
  chain_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  asset TEXT,
  asset_symbol TEXT,
  asset_decimals INT,
  share_decimals INT,
  PRIMARY KEY (chain_id, vault)
);

CREATE INDEX IF NOT EXISTS vault_metrics_ts ON vault_metrics (chain_id, vault, timestamp DESC);
