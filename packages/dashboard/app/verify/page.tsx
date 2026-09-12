"use client";

import { Buffer as PolyfillBuffer } from "buffer";
import { useState } from "react";
import { matchesIdentityPin, verifyReceipt, receiptHash, checkSig, fromB64, sha256Hex, type IdentityPin } from "@vaultradar/core";
import type { Receipt, Sig } from "@vaultradar/core";
import { checkAnchor, type AnchorState } from "@/lib/onchain";
import type { AgentCard } from "@/lib/service";

// `@vaultradar/core`'s base64 helpers use the Node.js `Buffer` global, which
// browsers don't provide. Polyfill it once, before any core function runs.
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof PolyfillBuffer }).Buffer = PolyfillBuffer;
}

const SERVICE_URL = (process.env.NEXT_PUBLIC_SERVICE_URL ?? "http://localhost:8787").replace(/\/$/, "");

type Anchor = { chainId: string; agentId: string; state: AnchorState };

export type Done = {
  status: "done";
  /** The receipt's own ML-DSA-65 signature, against the key the card publishes. */
  signatureValid: boolean;
  /** The card's own self-signature, against that same key. */
  cardSignatureValid: boolean;
  /** The receipt's `sig.pub_hash` against the card's `pq.sig.pub_hash`. */
  keyMatchesCard: boolean;
  /**
   * One entry per ERC-8004 identity the *receipt* names in its signed `service.erc8004`.
   * Empty means the receipt claims no on-chain identity, which is never "verified" — see
   * `isVerified`.
   */
  anchors: Anchor[];
  /** Every identity the receipt names also appears on the card that published the key. */
  identitiesInCard: boolean;
  /**
   * The identities this dashboard expects the service to have, from the operator's
   * configuration. Empty means nothing is pinned — see `isVerified`.
   */
  pins: IdentityPin[];
  /** Whether the receipt's signed identities include one of `pins`. */
  pinMatched: boolean;
  hash: string;
};

type Result = { status: "idle" } | { status: "checking" } | { status: "error"; message: string } | Done;

/**
 * A receipt reads "verified" only when its signature checks out, the card that published
 * the key vouches for itself, the receipt names that same key, and every ERC-8004 identity
 * the *receipt itself* claims anchors that key on chain.
 *
 * Checking a signature against whatever key a freshly fetched card advertises proves only
 * that the card and the receipt came from the same place: anyone who can answer for the
 * service's URL can serve a card with their own key and a receipt signed by it, and the
 * page would have said "Signature valid." The on-chain pin is the part an impostor cannot
 * rewrite — which is why the identities come from `receipt.service.erc8004`, inside the
 * signed body, rather than from the card. Reading them off the card let the impostor supply
 * an *empty* list and skip the on-chain check altogether, and an empty list used to read as
 * verified.
 *
 * So an empty list is "unproven", never "verified": there is nothing anchoring the key. The
 * identities are additionally cross-checked against the card, because a receipt naming an
 * identity the key's own publisher does not claim is two parties disagreeing about who this
 * service is.
 */
export function isVerified(r: Done): boolean {
  return (
    r.signatureValid &&
    r.cardSignatureValid &&
    r.keyMatchesCard &&
    r.identitiesInCard &&
    r.anchors.length > 0 &&
    r.anchors.every((a) => a.state === "matches") &&
    // The anchor binds a key to an agent id. Only the pin binds an agent id to a service:
    // the registry is permissionless, so an impostor who controls this URL can register an
    // id of their own and satisfy every other check here. With a pin set, "Verified" means
    // the identity the operator expected, not merely one that is internally consistent.
    (r.pins.length === 0 || r.pinMatched)
  );
}

export default function VerifyPage() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result>({ status: "idle" });

  async function onVerify() {
    setResult({ status: "checking" });

    let receipt: Receipt;
    try {
      receipt = JSON.parse(text) as Receipt;
    } catch {
      setResult({ status: "error", message: "That isn't valid JSON." });
      return;
    }
    if (!receipt || typeof receipt !== "object" || !receipt.sig || !receipt.sig.value) {
      setResult({ status: "error", message: "That doesn't look like a receipt — missing sig.value." });
      return;
    }

    let card: AgentCard;
    try {
      const res = await fetch(`${SERVICE_URL}/.well-known/agent.json`, { cache: "no-store" });
      if (!res.ok) throw new Error(`agent card fetch failed: ${res.status}`);
      card = (await res.json()) as AgentCard;
    } catch (err) {
      setResult({ status: "error", message: `Could not fetch the agent card from ${SERVICE_URL}: ${(err as Error).message}` });
      return;
    }

    try {
      const publicKey = fromB64(card.pq.sig.public_key);
      const signatureValid = verifyReceipt(receipt, publicKey);
      // The card signs itself with the same key it publishes, so this is checkable here
      // with no third party involved — and an unsigned or tampered card means nothing else
      // on this page can be trusted.
      const cardSignatureValid = checkSig(card as unknown as { sig?: Sig }, publicKey);
      // The card's claimed hash has to be the hash of the key it shipped, and the receipt
      // has to name that same key. `checkSig` above already binds the receipt's own
      // `pub_hash` to `publicKey`; this adds the card's claim to the chain of equalities so
      // the value compared on chain below is the key that actually signed.
      const publishedHash = sha256Hex(publicKey);
      const keyMatchesCard =
        card.pq.sig.pub_hash.trim().toLowerCase() === publishedHash &&
        receipt.sig.pub_hash.trim().toLowerCase() === publishedHash;

      // From the receipt's *signed* body, not the card: the card is fetched live from
      // whoever is answering for the service URL, so a list read off it is a list the
      // service being verified gets to choose — including an empty one, which would skip
      // the on-chain check entirely.
      const claimed = Array.isArray(receipt.service?.erc8004) ? receipt.service.erc8004 : [];
      const onCard = Array.isArray(card.erc8004) ? card.erc8004 : [];
      const identitiesInCard = claimed.every((c) =>
        onCard.some((o) => o.chainId === c.chainId && o.agentId === c.agentId),
      );
      const anchors: Anchor[] = await Promise.all(
        claimed.map(async (id) => {
          const checked = await checkAnchor(id, publishedHash);
          return { chainId: checked.chainId, agentId: checked.agentId, state: checked.state };
        }),
      );

      // The operator's pinned identity, if any. Fetched rather than inlined so a change does
      // not need a rebuild, and read here rather than from the card or the receipt for the
      // obvious reason: an expectation the verified party supplies is not an expectation.
      let pins: IdentityPin[] = [];
      try {
        const res = await fetch("/api/expected-identity", { cache: "no-store" });
        const body = (await res.json()) as { pins?: IdentityPin[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        pins = body.pins ?? [];
      } catch (err) {
        // Refuse rather than assume nothing is pinned: silently dropping a configured
        // expectation would report a pass this page never actually checked.
        setResult({ status: "error", message: `Could not read this dashboard's expected identity: ${(err as Error).message}` });
        return;
      }
      const pinMatched = matchesIdentityPin(claimed, pins);

      setResult({ status: "done", signatureValid, cardSignatureValid, keyMatchesCard, identitiesInCard, anchors, pins, pinMatched, hash: receiptHash(receipt) });
    } catch (err) {
      setResult({ status: "error", message: `Verification failed to run: ${(err as Error).message}` });
    }
  }

  return (
    <>
      <h2>Verify a receipt</h2>
      <p>
        Paste a receipt&rsquo;s JSON below. Its ML-DSA-65 signature is checked in your browser against the service&rsquo;s
        published key, and that key is checked against the hash pinned on the ERC-8004 registry for every identity the
        receipt itself names — a receipt that names none cannot be verified, only read. The receipt hash is recomputed
        too. If this dashboard has an expected identity configured, that identity must be among the ones the receipt
        names: the registry itself is open to anyone, so an on-chain anchor alone proves a key belongs to <em>an</em>
        agent, not to the service you meant to reach. The receipt is never sent anywhere: the only requests your browser
        makes are the one-time fetch of the agent card, a read-only call to a public RPC endpoint for the on-chain key,
        and this dashboard's own pin.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={16}
        placeholder='{"v":1,"service":{"erc8004":[...]},"request_hash":"...","...":"..."}'
      />
      <div>
        <button onClick={onVerify} disabled={text.trim().length === 0 || result.status === "checking"}>
          Verify
        </button>
      </div>
      {result.status === "checking" && <p>Checking&hellip;</p>}
      {result.status === "error" && <p className="error">{result.message}</p>}
      {result.status === "done" && <Verdict result={result} />}
    </>
  );
}

/** The one-line answer, naming the first thing that failed rather than a generic refusal. */
export function headline(r: Done): string {
  if (isVerified(r)) return "Verified.";
  if (!r.signatureValid) return "NOT verified: the signature is INVALID.";
  if (!r.cardSignatureValid) return "NOT verified: the agent card does not carry a valid signature of its own.";
  if (!r.keyMatchesCard) return "NOT verified: the signature is good, but the key behind it is not the published one.";
  if (!r.identitiesInCard) return "NOT verified: the receipt names an on-chain identity the service's own card does not claim.";
  if (r.anchors.length === 0) {
    return "UNPROVEN: the signature is good, but the receipt claims no on-chain identity, so nothing anchors the key.";
  }
  if (r.anchors.some((a) => a.state === "mismatch")) return "NOT verified: the on-chain registry pins a different key.";
  if (r.pins.length > 0 && !r.pinMatched) {
    return `NOT verified: the service's on-chain identity is not the one this dashboard expects (expected ${r.pins
      .map((p) => `${p.chainId}:${p.agentId}`)
      .join(", ")}).`;
  }
  return "UNPROVEN: the on-chain anchor could not be read, so the key binding is unconfirmed.";
}

function Verdict({ result }: { result: Done }) {
  const verified = isVerified(result);
  return (
    <>
      <p className={verified ? "ok" : "error"}>
        {headline(result)} Receipt hash: <code>{result.hash}</code>
      </p>
      <dl>
        <dt>Receipt signature</dt>
        <dd className={result.signatureValid ? "ok" : "error"}>{result.signatureValid ? "valid" : "invalid"}</dd>
        <dt>Agent card signature</dt>
        <dd className={result.cardSignatureValid ? "ok" : "error"}>{result.cardSignatureValid ? "valid" : "invalid"}</dd>
        <dt>Key hash matches the card</dt>
        <dd className={result.keyMatchesCard ? "ok" : "error"}>{result.keyMatchesCard ? "yes" : "no"}</dd>
        <dt>Identities the receipt names are on the card</dt>
        <dd className={result.identitiesInCard ? "ok" : "error"}>{result.identitiesInCard ? "yes" : "no"}</dd>
        <dt>On-chain anchor</dt>
        <dd>
          {result.anchors.length === 0 ? (
            <span className="error">
              the receipt names no ERC-8004 identity in its signed body, so there is nothing to check the key against and
              only the service&rsquo;s own word supports it
            </span>
          ) : (
            result.anchors.map((a) => (
              <span className="pill" key={`${a.chainId}-${a.agentId}`}>
                chain <code>{a.chainId}</code> agent <code>{a.agentId}</code>:{" "}
                <span className={a.state === "matches" ? "ok" : a.state === "mismatch" ? "error" : "warn"}>{a.state}</span>
              </span>
            ))
          )}
        </dd>
        <dt>Expected identity</dt>
        <dd>
          {result.pins.length === 0 ? (
            <span className="warn">
              none configured, so the checks above establish that the service is internally consistent and that its key
              is registered under <em>an</em> agent id — not that the id belongs to the service you meant to reach
            </span>
          ) : result.pinMatched ? (
            <span className="ok">
              matches <code>{result.pins.map((p) => `${p.chainId}:${p.agentId}`).join(", ")}</code>
            </span>
          ) : (
            <span className="error">
              not <code>{result.pins.map((p) => `${p.chainId}:${p.agentId}`).join(", ")}</code>
            </span>
          )}
        </dd>
      </dl>
      {result.anchors.some((a) => a.state === "unavailable") && (
        <p className="muted">
          &ldquo;unavailable&rdquo; means the registry could not be read, or holds no hash for that agent — not that the
          key is wrong. Nothing is claimed either way, which is why the verdict above is unproven rather than a refusal.
        </p>
      )}
    </>
  );
}
