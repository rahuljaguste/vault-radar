### Task 17: HCS commitments and receipt lookup

**Files:**
- Create: `packages/service/src/hcs.ts`, `packages/service/test/hcs.test.ts`
- Modify: `packages/service/src/app.ts`, `packages/service/src/rails/hedera.ts` (call `onSettled`)

**Interfaces:**
- Produces: `class HcsQueue { constructor(deps: { submit: (message: string) => Promise<{ sequence: string; consensusTimestamp: string }>; topicId: string }); enqueue(receipt: Receipt): void; lookup(receiptHash: string): Promise<LookupResult>; pending(): number }`; `LookupResult = { receipt_hash: string; topicId: string; sequence: string | null; consensus_timestamp: string | null; initial_transaction_id: string | null }`; `makeHederaSubmit(config): (message) => Promise<...>` using `@hashgraph/sdk` `TopicMessageSubmitTransaction`; `mirrorLookup(topicId, receiptHash)` scanning `https://testnet.mirrornode.hedera.com/api/v1/topics/{id}/messages?limit=100&order=desc` and reassembling chunks by `chunk_info.initial_transaction_id`.
- Message format (spec §5.5): `{ v: 1, receipt_hash, sig: receipt.sig, issued_at }` as canonical JSON (about 4.6 KB → 5 chunks).

- [ ] **Step 1: Failing test with a fake submit**

```ts
import { expect, test } from "bun:test";
import { HcsQueue } from "../src/hcs";
import { buildReceipt, deriveSigningKeys, receiptHash } from "@vaultradar/core";
const keys = deriveSigningKeys("99".repeat(32));
const r = buildReceipt({ service: { erc8004: [] }, request_hash: "a".repeat(64), response_hash: "b".repeat(64), sealed: true, sources: [], price: { amount: "1", asset: "x", rail: "hedera" }, payment: { rail: "hedera", txId: "t" }, tier: "scan", hcs: { topicId: "0.0.5" } }, keys);
test("enqueue submits once, retries on failure, lookup returns sequence", async () => {
  let calls = 0; const submit = async (m: string) => { calls++; if (calls === 1) throw new Error("boom"); expect(JSON.parse(m).receipt_hash).toBe(receiptHash(r)); return { sequence: "42", consensusTimestamp: "1.000" }; };
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 5 });
  q.enqueue(r); await new Promise(res => setTimeout(res, 50));
  expect(calls).toBe(2);
  expect(await q.lookup(receiptHash(r))).toMatchObject({ sequence: "42", topicId: "0.0.5" });
  expect((await q.lookup("f".repeat(64))).sequence).toBeNull();
});
```

- [ ] **Step 2: Implement**

```ts
import { Client, PrivateKey, TopicMessageSubmitTransaction, TopicId } from "@hashgraph/sdk";
import { canonicalize, receiptHash, type Receipt } from "@vaultradar/core";
import type { Config } from "./config";
export type LookupResult = { receipt_hash: string; topicId: string; sequence: string | null; consensus_timestamp: string | null; initial_transaction_id: string | null };
type Submit = (message: string) => Promise<{ sequence: string; consensusTimestamp: string; transactionId?: string }>;
export class HcsQueue {
  private done = new Map<string, LookupResult>(); private q: Receipt[] = []; private running = false; private retryMs: number;
  constructor(private deps: { submit: Submit; topicId: string; retryMs?: number }) { this.retryMs = deps.retryMs ?? 2000; }
  pending() { return this.q.length; }
  enqueue(r: Receipt) { this.q.push(r); void this.drain(); }
  private async drain() { if (this.running) return; this.running = true;
    while (this.q.length) { const r = this.q[0]; const h = receiptHash(r);
      try { const res = await this.deps.submit(canonicalize({ v: 1, receipt_hash: h, sig: r.sig, issued_at: r.issued_at }));
        this.done.set(h, { receipt_hash: h, topicId: this.deps.topicId, sequence: res.sequence, consensus_timestamp: res.consensusTimestamp, initial_transaction_id: res.transactionId ?? null }); this.q.shift(); }
      catch { await new Promise(res => setTimeout(res, this.retryMs)); } }
    this.running = false; }
  async lookup(h: string): Promise<LookupResult> { return this.done.get(h) ?? { receipt_hash: h, topicId: this.deps.topicId, sequence: null, consensus_timestamp: null, initial_transaction_id: null }; }
}
export function makeHederaSubmit(c: Config): Submit {
  const client = Client.forTestnet().setOperator(c.hedera.operatorId, PrivateKey.fromStringECDSA(c.hedera.operatorKey));
  return async (message) => {
    const tx = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(c.hedera.hcsTopicId!)).setMessage(message).execute(client);
    const rc = await tx.getReceipt(client);
    return { sequence: rc.topicSequenceNumber?.toString() ?? "0", consensusTimestamp: (await tx.getRecord(client)).consensusTimestamp.toString(), transactionId: tx.transactionId.toString() };
  };
}
```

Wire: `main.ts` constructs `HcsQueue` only when `HEDERA_HCS_TOPIC_ID` is set; `mountHederaRail(..., { onSettled: (receipt) => hcs.enqueue(receipt) })` and the Arc rail (Task 19) the same. `wellknown.ts` `/v1/receipts/:hash` delegates to `hcs.lookup`; when the in-memory map misses (after a restart) fall back to `mirrorLookup` which pages the mirror node and matches `receipt_hash` inside reassembled messages.

- [ ] **Step 3: Run, expect pass. Commit**, `git add -A && git commit -m "feat(service): HCS commitment queue with retry and receipt lookup"`

