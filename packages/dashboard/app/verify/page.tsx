"use client";

import { Buffer as PolyfillBuffer } from "buffer";
import { useState } from "react";
import { verifyReceipt, receiptHash, fromB64 } from "@vaultradar/core";
import type { Receipt } from "@vaultradar/core";
import type { AgentCard } from "@/lib/service";

// `@vaultradar/core`'s base64 helpers use the Node.js `Buffer` global, which
// browsers don't provide. Polyfill it once, before any core function runs.
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof PolyfillBuffer }).Buffer = PolyfillBuffer;
}

const SERVICE_URL = (process.env.NEXT_PUBLIC_SERVICE_URL ?? "http://localhost:8787").replace(/\/$/, "");

type Result = { status: "idle" } | { status: "checking" } | { status: "error"; message: string } | { status: "done"; valid: boolean; hash: string };

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
      const valid = verifyReceipt(receipt, publicKey);
      const hash = receiptHash(receipt);
      setResult({ status: "done", valid, hash });
    } catch (err) {
      setResult({ status: "error", message: `Verification failed to run: ${(err as Error).message}` });
    }
  }

  return (
    <>
      <h2>Verify a receipt</h2>
      <p>Paste a receipt&rsquo;s JSON below. This checks its ML-DSA-65 signature in your browser against the service&rsquo;s current public key — nothing is sent anywhere except the one-time fetch of the agent card.</p>
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
      {result.status === "checking" && <p>Checking…</p>}
      {result.status === "error" && <p className="error">{result.message}</p>}
      {result.status === "done" && (
        <p className={result.valid ? "ok" : "error"}>
          {result.valid ? "Signature valid." : "Signature INVALID."} Receipt hash: <code>{result.hash}</code>
        </p>
      )}
    </>
  );
}
