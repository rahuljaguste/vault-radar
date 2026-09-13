import { readFileSync } from "node:fs";
import { z } from "zod";
import { receiptHash, type Attestation, type Rail, type RiskReport } from "@vaultradar/core";
import type { PaidResult } from "./client";
import type { Decision } from "./runs";

/**
 * The operator's standing instructions, loaded once per run from a JSON file. Budgets
 * are per-rail caps in USD decimal strings (same unit as the quotes `VaultRadarClient`
 * returns, so the two compare directly); `max_age_seconds` is the agent's *own*
 * freshness bar, applied to attestation timestamps independently of whatever
 * freshness the service claims.
 */
export type Policy = {
  budget: { usdc_hedera: string; usdc_arc: string };
  privacy: "strict" | "balanced" | "cheap";
  rail_preference: "cheapest" | "hedera" | "arc";
  max_age_seconds: number;
  /**
   * On-chain identities this policy expects the service to have. Absent or empty pins
   * nothing; `loadPolicy` fills in `[]` for a file that omits it.
   */
  expected_erc8004?: { chainId: string; agentId: string }[];
};

/** A non-negative decimal amount written as a string, e.g. `"1.00"` or `"0.0015"`. */
const usd = z
  .string()
  .refine(s => /^\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s)), {
    message: "must be a non-negative decimal amount written as a string, e.g. \"1.00\"",
  });

export const PolicySchema = z.object({
  budget: z.object({ usdc_hedera: usd, usdc_arc: usd }),
  privacy: z.enum(["strict", "balanced", "cheap"]).default("balanced"),
  rail_preference: z.enum(["cheapest", "hedera", "arc"]).default("cheapest"),
  max_age_seconds: z.number().int().positive().default(900),
  /**
   * The on-chain identities this policy expects the service to have, as
   * `{ chainId, agentId }`. Empty (the default) means the anchor checks run as before,
   * which proves the key is registered under *an* agent id — not that the id is the one
   * meant to be called, since the ERC-8004 registry is permissionless and an impostor can
   * register their own. Set this to the ids you know out of band and a service claiming
   * any other identity is refused before anything is paid.
   */
  expected_erc8004: z.array(z.object({ chainId: z.string().min(1), agentId: z.string().min(1) })).default([]),
});

/**
 * Reads and validates a policy file, applying defaults for every field but `budget`
 * (which has no safe default — an unstated spending cap should never be inferred).
 * Throws with the offending field named, since a misread policy silently spending
 * real USDC is far worse than a failed run.
 */
export function loadPolicy(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`policy not readable at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`policy at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`policy at ${path} is invalid, ${issues}`);
  }
  return parsed.data;
}

export type RailChoice = { rail: Rail; reason: string } | { rail: null; reason: string };

type Quotes = { hedera: string | null; arc: string | null };
type Amounts = { hedera: string; arc: string };
type Health = { hedera: boolean; arc: boolean };

const RAILS = ["hedera", "arc"] as const;

/**
 * A rail is usable only if all four hold: it quoted a price at all (a null quote means
 * the wallet for that rail isn't configured), its facilitator is reachable, the wallet
 * holds at least the quoted amount, and the policy budgets at least that much for it.
 * Budget and balance are separate gates on purpose — funds you have but haven't
 * authorised for this agent are not spendable.
 */
function usable(p: Policy, rail: Rail, quotes: Quotes, balances: Amounts, health: Health): number | null {
  const quote = quotes[rail];
  if (quote == null) return null;
  const price = Number(quote);
  if (!Number.isFinite(price)) return null;
  if (!health[rail]) return null;
  const balance = Number(balances[rail]);
  if (!Number.isFinite(balance) || balance < price) return null;
  const budget = Number(rail === "hedera" ? p.budget.usdc_hedera : p.budget.usdc_arc);
  if (!Number.isFinite(budget) || budget < price) return null;
  return price;
}

/**
 * Picks the rail to buy on. `"cheapest"` takes the lowest usable quote, breaking an exact
 * tie towards hedera. Neither rail is uniformly cheaper: Hedera's metered price undercuts
 * Arc's bucket at the low end of each bucket and Arc's undercuts it at the high end (at
 * current prices Arc wins at 5, 20 and 100 vaults; Hedera at 1, 6 and 21). So ties are not
 * confined to the flat-priced table tier — they also happen wherever the metered price
 * lands exactly on a bucket price, which is 4, 18 and 98 vaults today. The tie-break is
 * what decides those.
 *
 * A named preference is honoured when usable and otherwise falls back to the other rail,
 * reporting `preferred_rail_unusable` so the run record shows the substitution rather than
 * hiding it.
 */
export function chooseRail(p: Policy, quotes: Quotes, balances: Amounts, health: Health): RailChoice {
  const prices = new Map<Rail, number>();
  for (const rail of RAILS) {
    const price = usable(p, rail, quotes, balances, health);
    if (price != null) prices.set(rail, price);
  }

  if (p.rail_preference === "cheapest") {
    // RAILS order puts hedera first, so a stable sort on price alone tie-breaks to it.
    const cheapest = [...prices.entries()].sort((a, b) => a[1] - b[1])[0];
    return cheapest ? { rail: cheapest[0], reason: "cheapest_usable_rail" } : { rail: null, reason: "no_usable_rail" };
  }

  const preferred = p.rail_preference;
  if (prices.has(preferred)) return { rail: preferred, reason: "preferred_rail" };
  const other: Rail = preferred === "hedera" ? "arc" : "hedera";
  if (prices.has(other)) return { rail: other, reason: "preferred_rail_unusable" };
  return { rail: null, reason: "no_usable_rail" };
}

/**
 * Maps the privacy tier to what to buy: `strict` takes the whole protocol table (the
 * service never learns which vault the agent cares about), `balanced` a sealed scan of
 * exactly the named vaults, `cheap` the same scan in the clear.
 */
export function chooseTier(p: Policy): { tier: "scan" | "table"; seal: boolean } {
  if (p.privacy === "strict") return { tier: "table", seal: true };
  return { tier: "scan", seal: p.privacy === "balanced" };
}

export type AgeCheck = { accepted: Attestation[]; rejected: { vaultId: string; ageSeconds: number }[] };

/**
 * How far an attestation may be dated into the future before the agent stops believing
 * it. Some slack is necessary because the service's clock, the chain it read, and the
 * agent's own clock are three different clocks; two minutes matches the sealed-request
 * timestamp window in `@vaultradar/core` (`TS_WINDOW_S`). Beyond that, a future date is
 * not skew — it is a timestamp that cannot be true yet.
 */
export const CLOCK_SKEW_S = 120;

/**
 * The agent's own freshness check, run against the signed attestation timestamps
 * rather than the service's `freshness` classification — so a service that widens its
 * own staleness window, or whose upstream is lagging, cannot talk the agent into
 * acting on old numbers.
 *
 * Rejects in both directions. Too old is the obvious case. Too far in the *future*
 * matters just as much: `ageSeconds` goes negative there, and a bare
 * `ageSeconds > max_age_seconds` test would accept a timestamp dated next year as
 * arbitrarily fresh — turning the freshness bar into something a misbehaving service
 * could step over at will. The rejection records the real (possibly negative)
 * `ageSeconds`, so the run file shows which direction it failed in.
 *
 * An attestation whose timestamp doesn't parse is treated as dating from the epoch
 * (age = `now`), which is both finite — `rejected[].ageSeconds` is a plain number in
 * the run-file contract — and unambiguously past any sane `max_age_seconds`.
 */
export function applyAgeCheck(result: PaidResult, p: Policy, now: number): AgeCheck {
  const accepted: Attestation[] = [];
  const rejected: { vaultId: string; ageSeconds: number }[] = [];
  for (const a of result.attestations) {
    const ts = Number(a.timestamp);
    const ageSeconds = Number.isFinite(ts) ? now - ts : now;
    if (ageSeconds > p.max_age_seconds || ageSeconds < -CLOCK_SKEW_S) {
      rejected.push({ vaultId: a.vaultId, ageSeconds });
    } else {
      accepted.push(a);
    }
  }
  return { accepted, rejected };
}

const ACTION_FOR = {
  alert: "withdraw",
  watch: "rebalance",
  ok: "hold",
} as const;

const flagNames = (r: RiskReport) => (r.flags.length ? r.flags.map(f => f.name).join(", ") : null);

/**
 * Turns a verified, age-checked purchase into one action per vault, each carrying the
 * evidence a reader needs to check it: the block and source the verdict was computed
 * from, the payment that bought it, and the hash of the signed receipt.
 *
 * Three things force `"insufficient data"` rather than an action: the service itself
 * reporting `unavailable`, the age check rejecting the vault's attestation, and the
 * vault having no accepted attestation at all. The third covers a service that returns
 * a report it never attested to — unattested numbers are not evidence, so they can't
 * be acted on either.
 */
export function decide(result: PaidResult, age: AgeCheck): Decision[] {
  const rejected = new Map(age.rejected.map(r => [r.vaultId, r.ageSeconds]));
  const accepted = new Map(age.accepted.map(a => [a.vaultId, a]));
  const hash = receiptHash(result.receipt);

  return result.reports.map(report => {
    const attestation = accepted.get(report.vaultId);
    const evidence = report.evidence[0];
    const citations = {
      block: evidence?.block ?? attestation?.block ?? "",
      source: evidence?.source ?? attestation?.source ?? "",
      // The rail-level `txId` comes from the payment-response header, which only real
      // x402 middleware sets; the receipt always carries the identifier the payer
      // committed to. Falling back keeps every citation pointing at a real payment, and
      // matches what `watch` prints and what the scan tool returns.
      txId: result.txId ?? result.receipt.payment.txId,
      receiptHash: hash,
    };
    const flags = flagNames(report);
    const withFlags = flags ? `flags ${flags}` : "no flags";

    const staleBy = rejected.get(report.vaultId);
    if (staleBy != null) {
      // A negative age means the attestation is dated ahead of our clock by more than
      // CLOCK_SKEW_S; say so rather than reporting a nonsensical "-5000s old".
      const how =
        staleBy < 0
          ? `Attestation is dated ${-staleBy}s in the future, beyond the ${CLOCK_SKEW_S}s clock-skew allowance`
          : `Attestation is ${staleBy}s old, beyond the policy's max age`;
      return {
        vaultId: report.vaultId,
        action: "insufficient data" as const,
        reason: `${how}, so the ${report.verdict} verdict (${withFlags}) cannot be acted on.`,
        citations,
      };
    }
    if (!attestation) {
      return {
        vaultId: report.vaultId,
        action: "insufficient data" as const,
        reason: `The service returned no attestation for this vault, so its ${report.verdict} verdict (${withFlags}) is unattested.`,
        citations,
      };
    }
    if (report.verdict === "unavailable") {
      return {
        vaultId: report.vaultId,
        action: "insufficient data" as const,
        reason: `The service reported verdict unavailable (${withFlags}), so there is nothing to act on.`,
        citations,
      };
    }
    const action = ACTION_FOR[report.verdict];
    return {
      vaultId: report.vaultId,
      action,
      reason: `Verdict ${report.verdict} at score ${report.score} with ${withFlags}: ${action}.`,
      citations,
    };
  });
}
