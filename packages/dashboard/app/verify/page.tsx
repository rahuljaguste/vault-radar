"use client";

import { Buffer as PolyfillBuffer } from "buffer";
import { useState } from "react";
import { verifyReceipt, receiptHash, checkSig, fromB64, sha256Hex } from "@vaultradar/core";
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
  /** One entry per ERC-8004 identity the card lists; empty when it lists none. */
  anchors: Anchor[];
  hash: string;
};

type Result = { status: "idle" } | { status: "checking" } | { status: "error"; message: string } | Done;

/**
 * A receipt only reads "verified" when all of these hold: its signature checks out, the
 * card that published the key vouches for itself, the receipt names that same key, and —
 * when the card claims on-chain identities — every one of those anchors the key too.
 *
 * The middle two are what make the first one mean anything. Checking a signature against
 * whatever key a freshly fetched card happens to advertise proves only that the card and
 * the receipt came from the same place; anyone who can answer for the service's URL can
 * serve a card with their own key and a receipt signed by it, and the page would have said
 * "Signature valid." The on-chain pin is the part an impostor cannot rewrite.
 */
export function isVerified(r: Done): boolean {
  return (
    r.signatureValid &&
    r.cardSignatureValid &&
    r.keyMatchesCard &&
    (r.anchors.length === 0 || r.anchors.every((a) => a.state === "matches"))
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

      const identities = Array.isArray(card.erc8004) ? card.erc8004 : [];
      const anchors: Anchor[] = await Promise.all(
        identities.map(async (id) => {
          const checked = await checkAnchor(id, card.pq.sig.pub_hash);
          return { chainId: checked.chainId, agentId: checked.agentId, state: checked.state };
        }),
      );

      setResult({ status: "done", signatureValid, cardSignatureValid, keyMatchesCard, anchors, hash: receiptHash(receipt) });
    } catch (err) {
      setResult({ status: "error", message: `Verification failed to run: ${(err as Error).message}` });
    }
  }

  return (
    <>
      <h2>Verify a receipt</h2>
      <p>
        Paste a receipt&rsquo;s JSON below. Its ML-DSA-65 signature is checked in your browser against the service&rsquo;s
        published key, that key is checked against the hash the service has pinned on the ERC-8004 registry, and the
        receipt hash is recomputed. The receipt itself is never sent anywhere: the only requests your browser makes are
        the one-time fetch of the agent card and a read-only call to a public RPC endpoint for the on-chain key.
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

function Verdict({ result }: { result: Done }) {
  const verified = isVerified(result);
  return (
    <>
      <p className={verified ? "ok" : "error"}>
        {verified
          ? "Verified."
          : result.signatureValid
            ? "NOT verified: the signature checks out, but the key behind it does not."
            : "NOT verified: the signature is INVALID."}{" "}
        Receipt hash: <code>{result.hash}</code>
      </p>
      <dl>
        <dt>Receipt signature</dt>
        <dd className={result.signatureValid ? "ok" : "error"}>{result.signatureValid ? "valid" : "invalid"}</dd>
        <dt>Agent card signature</dt>
        <dd className={result.cardSignatureValid ? "ok" : "error"}>{result.cardSignatureValid ? "valid" : "invalid"}</dd>
        <dt>Key hash matches the card</dt>
        <dd className={result.keyMatchesCard ? "ok" : "error"}>{result.keyMatchesCard ? "yes" : "no"}</dd>
        <dt>On-chain anchor</dt>
        <dd>
          {result.anchors.length === 0 ? (
            <span className="warn">
              the card lists no ERC-8004 identity, so the key is not anchored anywhere and only the service&rsquo;s own
              word supports it
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
      </dl>
      {result.anchors.some((a) => a.state === "unavailable") && (
        <p className="muted">
          &ldquo;unavailable&rdquo; means the registry could not be read, or holds no hash for that agent — not that the
          key is wrong. Nothing is claimed either way.
        </p>
      )}
    </>
  );
}
