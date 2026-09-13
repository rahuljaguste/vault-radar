import { expect, test } from "bun:test";
import type { Client } from "@hashgraph/sdk";
import { buildReceipt, canonicalize, deriveSigningKeys, receiptHash } from "@vaultradar/core";
import { loadConfig } from "../src/config";
import { DONE_MAX, HcsQueue, MAX_CONSECUTIVE_FAILURES, makeHederaSubmit, mirrorLookup } from "../src/hcs";

const keys = deriveSigningKeys("99".repeat(32));
const r = buildReceipt(
  {
    service: { erc8004: [] },
    request_hash: "a".repeat(64),
    response_hash: "b".repeat(64),
    sealed: true,
    sources: [],
    price: { amount: "1", asset: "x", rail: "hedera" },
    payment: { rail: "hedera", txId: "t" },
    tier: "scan",
    hcs: { topicId: "0.0.5" },
  },
  keys,
);

/** Never used by these tests — every scenario injects its own fetchImpl — but stands
 * in as the default so a lookup miss can't accidentally reach the real mirror node if
 * a test forgets to pass one. */
const emptyMirrorPage = async () => new Response(JSON.stringify({ messages: [], links: { next: null } }), { status: 200 });

test("enqueue submits once, retries on failure, lookup returns the sequence", async () => {
  let calls = 0;
  const submit = async (m: string) => {
    calls++;
    if (calls === 1) throw new Error("boom");
    expect(JSON.parse(m).receipt_hash).toBe(receiptHash(r));
    return { sequence: "42", consensusTimestamp: "1.000" };
  };
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 5, fetchImpl: emptyMirrorPage });
  q.enqueue(r);
  await new Promise(res => setTimeout(res, 50));
  expect(calls).toBe(2);
  expect(q.pending()).toBe(0);
  expect(await q.lookup(receiptHash(r))).toMatchObject({ sequence: "42", topicId: "0.0.5" });
  expect((await q.lookup("f".repeat(64))).sequence).toBeNull();
});

test("enqueue is synchronous: it returns void immediately, so a caller never has to await it", () => {
  const submit = () => new Promise<never>(() => {}); // never resolves, proves nothing here waits on it
  const q = new HcsQueue({ submit, topicId: "0.0.5", fetchImpl: emptyMirrorPage });
  const returned = q.enqueue(r);
  expect(returned).toBeUndefined();
  // Observable synchronously right after the call returns, with no await in between —
  // this is what lets a route's settlement hook call enqueue() and move on without
  // ever blocking the response that already went out.
  expect(q.pending()).toBe(1);
});

const hcsConfig = loadConfig({
  PQ_SIG_SEED: "22".repeat(32), PQ_KEM_SEED: "33".repeat(64), GRAPH_STUDIO_API_KEY: "k",
  HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "11".repeat(32), HEDERA_HCS_TOPIC_ID: "0.0.5",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.2", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40),
});

test(
  "makeHederaSubmit reports the last chunk's sequence/timestamp and the first chunk's transaction id",
  async () => {
    // A 3-chunk fake TopicMessageSubmitTransaction: only implements executeAll (no execute
    // at all), so calling the wrong SDK method throws immediately instead of attempting a
    // real network call.
    const responses = [1, 2, 3].map(n => ({
      transactionId: { toString: () => `0.0.1@1700000000.00000000${n}` },
      getReceipt: async () => ({ topicSequenceNumber: { toString: () => String(40 + n) } }),
      getRecord: async () => ({ consensusTimestamp: { toString: () => `1700000000.${n}00000000` } }),
    }));
    const fakeTx = { setTopicId: () => fakeTx, setMessage: () => fakeTx, executeAll: async () => responses };
    const submit = makeHederaSubmit(hcsConfig, { makeTx: () => fakeTx as any, client: {} as unknown as Client });

    const result = await submit("a message that would need several chunks");

    expect(result.transactionId).toBe("0.0.1@1700000000.000000001"); // first chunk
    expect(result.sequence).toBe("43"); // last chunk: 40 + 3
    expect(result.consensusTimestamp).toBe("1700000000.300000000"); // last chunk
  },
  3000,
);

test("lookup falls back to the mirror node when the in-memory map misses, then to a null record", async () => {
  const hash = receiptHash(r);
  const text = canonicalize({ v: 1, receipt_hash: hash, sig: r.sig, issued_at: r.issued_at });
  const bytes = new TextEncoder().encode(text);
  const mid = Math.ceil(bytes.length / 2);
  const txId = { account_id: "0.0.42", nonce: 0, scheduled: false, transaction_valid_start: "1700000000.000000001" };
  const messages = [
    { chunk_info: { initial_transaction_id: txId, number: 1, total: 2 }, consensus_timestamp: "1700000000.100000000", message: Buffer.from(bytes.slice(0, mid)).toString("base64"), sequence_number: 10, topic_id: "0.0.5" },
    { chunk_info: { initial_transaction_id: txId, number: 2, total: 2 }, consensus_timestamp: "1700000000.200000000", message: Buffer.from(bytes.slice(mid)).toString("base64"), sequence_number: 11, topic_id: "0.0.5" },
  ];
  const fetchImpl = async () => new Response(JSON.stringify({ messages, links: { next: null } }), { status: 200 });
  const q = new HcsQueue({ submit: async () => ({ sequence: "0", consensusTimestamp: "0" }), topicId: "0.0.5", fetchImpl });

  const hit = await q.lookup(hash);
  expect(hit).toEqual({
    receipt_hash: hash,
    topicId: "0.0.5",
    sequence: "11",
    consensus_timestamp: "1700000000.200000000",
    initial_transaction_id: "0.0.42@1700000000.000000001",
  });

  const miss = await q.lookup("f".repeat(64));
  expect(miss).toEqual({ receipt_hash: "f".repeat(64), topicId: "0.0.5", sequence: null, consensus_timestamp: null, initial_transaction_id: null });
});

test("mirrorLookup reassembles two chunks (in either arrival order) and matches on receipt_hash", async () => {
  const hash = receiptHash(r);
  const text = canonicalize({ v: 1, receipt_hash: hash, sig: r.sig, issued_at: r.issued_at });
  const bytes = new TextEncoder().encode(text);
  const mid = Math.ceil(bytes.length / 2);
  const txId = { account_id: "0.0.1234", nonce: 0, scheduled: false, transaction_valid_start: "1690000000.000000001" };
  const chunk1 = { chunk_info: { initial_transaction_id: txId, number: 1, total: 2 }, consensus_timestamp: "1690000000.100000000", message: Buffer.from(bytes.slice(0, mid)).toString("base64"), sequence_number: 20, topic_id: "0.0.9" };
  const chunk2 = { chunk_info: { initial_transaction_id: txId, number: 2, total: 2 }, consensus_timestamp: "1690000000.200000000", message: Buffer.from(bytes.slice(mid)).toString("base64"), sequence_number: 21, topic_id: "0.0.9" };

  // order=desc from the real mirror node means newest-first; reversed here to prove
  // reassembly sorts by chunk_info.number rather than relying on array order.
  const fetchImpl = async (url: string) => {
    expect(url).toBe("https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9/messages?limit=100&order=desc");
    return new Response(JSON.stringify({ messages: [chunk2, chunk1], links: { next: null } }), { status: 200 });
  };

  const result = await mirrorLookup("0.0.9", hash, fetchImpl);
  expect(result).toEqual({
    receipt_hash: hash,
    topicId: "0.0.9",
    sequence: "21",
    consensus_timestamp: "1690000000.200000000",
    initial_transaction_id: "0.0.1234@1690000000.000000001",
  });
});

test("mirrorLookup follows links.next across pages to complete a message split across pages", async () => {
  const hash = receiptHash(r);
  const text = canonicalize({ v: 1, receipt_hash: hash, sig: r.sig, issued_at: r.issued_at });
  const bytes = new TextEncoder().encode(text);
  const mid = Math.ceil(bytes.length / 2);
  const txId = { account_id: "0.0.55", nonce: 0, scheduled: false, transaction_valid_start: "1690000001.000000001" };
  const chunk1 = { chunk_info: { initial_transaction_id: txId, number: 1, total: 2 }, consensus_timestamp: "1690000001.100000000", message: Buffer.from(bytes.slice(0, mid)).toString("base64"), sequence_number: 30, topic_id: "0.0.9" };
  const chunk2 = { chunk_info: { initial_transaction_id: txId, number: 2, total: 2 }, consensus_timestamp: "1690000001.200000000", message: Buffer.from(bytes.slice(mid)).toString("base64"), sequence_number: 31, topic_id: "0.0.9" };

  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ messages: [chunk2], links: { next: "/api/v1/topics/0.0.9/messages?limit=100&order=desc&timestamp=lt:1690000001.200000000" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ messages: [chunk1], links: { next: null } }), { status: 200 });
  };

  const result = await mirrorLookup("0.0.9", hash, fetchImpl);
  expect(calls).toEqual([
    "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9/messages?limit=100&order=desc",
    "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9/messages?limit=100&order=desc&timestamp=lt:1690000001.200000000",
  ]);
  expect(result?.receipt_hash).toBe(hash);
  expect(result?.sequence).toBe("31");
});

test("mirrorLookup returns null on no match, on a non-ok response, and on a fetch that throws", async () => {
  expect(await mirrorLookup("0.0.9", "f".repeat(64), async () => new Response(JSON.stringify({ messages: [], links: { next: null } }), { status: 200 }))).toBeNull();
  expect(await mirrorLookup("0.0.9", "f".repeat(64), async () => new Response("nope", { status: 500 }))).toBeNull();
  expect(await mirrorLookup("0.0.9", "f".repeat(64), async () => { throw new Error("network down"); })).toBeNull();
});

test("mirrorLookup gives up after 5 pages", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ messages: [], links: { next: "/api/v1/topics/0.0.9/messages?limit=100&order=desc&timestamp=lt:x" } }), { status: 200 });
  };
  const result = await mirrorLookup("0.0.9", "f".repeat(64), fetchImpl);
  expect(result).toBeNull();
  expect(calls.length).toBe(5);
});

// --- queue health: the confirmed-lookup cap and head-of-queue rotation ---------------

/** A receipt that differs from every other by its price, so `receiptHash` differs too. */
function receiptN(n: number) {
  return buildReceipt(
    {
      service: { erc8004: [] },
      request_hash: "a".repeat(64),
      response_hash: "b".repeat(64),
      sealed: true,
      sources: [],
      price: { amount: String(n), asset: "x", rail: "hedera" },
      payment: { rail: "hedera", txId: `t${n}` },
      tier: "scan",
      hcs: { topicId: "0.0.5" },
    },
    keys,
  );
}

test("the confirmed-lookup map keeps every entry while under the cap, and never double-counts a resubmit", async () => {
  // The shipped cap is 10 000; filling it would need 10 002 ML-DSA signatures, so the
  // constant is asserted directly and the eviction *policy* is driven through the
  // injectable `doneMax` in the next test.
  expect(DONE_MAX).toBe(10_000);

  const submit = async () => ({ sequence: "1", consensusTimestamp: "1.000" });
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 1, fetchImpl: emptyMirrorPage });
  const receipts = Array.from({ length: 12 }, (_, i) => receiptN(i));
  for (const r of receipts) q.enqueue(r);
  await new Promise(res => setTimeout(res, 200));
  expect(q.pending()).toBe(0);
  for (const r of receipts) expect((await q.lookup(receiptHash(r))).sequence).toBe("1");

  // A hash submitted twice must not occupy two of the cap's slots.
  q.enqueue(receipts[0]);
  await new Promise(res => setTimeout(res, 50));
  expect((await q.lookup(receiptHash(receipts[0]))).sequence).toBe("1");
  expect(q.doneSizeForTests()).toBe(12);
});

test("the cap evicts the oldest confirmed entry, which then falls back to the mirror node", async () => {
  const submit = async () => ({ sequence: "7", consensusTimestamp: "7.000" });
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 1, fetchImpl: emptyMirrorPage, doneMax: 3 });
  const receipts = Array.from({ length: 5 }, (_, i) => receiptN(100 + i));
  for (const r of receipts) q.enqueue(r);
  await new Promise(res => setTimeout(res, 200));

  expect(q.doneSizeForTests()).toBe(3);
  // The two oldest were evicted to make room; the three newest are still cached. The map
  // is a cache, so an evicted hash reads as "sequence unknown" (the mirror-node
  // fallback), never as an error.
  expect((await q.lookup(receiptHash(receipts[0]))).sequence).toBeNull();
  expect((await q.lookup(receiptHash(receipts[1]))).sequence).toBeNull();
  for (const r of receipts.slice(2)) expect((await q.lookup(receiptHash(r))).sequence).toBe("7");
});

test("a receipt that fails MAX_CONSECUTIVE_FAILURES submits moves to the back, so the queue keeps draining", async () => {
  expect(MAX_CONSECUTIVE_FAILURES).toBe(5);
  const stuck = receiptN(201);
  const stuckHash = receiptHash(stuck);
  const good = receiptN(202);
  const goodHash = receiptHash(good);

  const attempts: string[] = [];
  const submit = async (message: string) => {
    const hash = JSON.parse(message).receipt_hash as string;
    attempts.push(hash);
    // Fails deterministically forever — the case that used to block every message behind it.
    if (hash === stuckHash) throw new Error("topic gone");
    return { sequence: "9", consensusTimestamp: "9.000" };
  };
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 1, fetchImpl: emptyMirrorPage });
  q.enqueue(stuck);
  q.enqueue(good);
  await new Promise(res => setTimeout(res, 300));

  // The good receipt committed despite being queued behind a permanently failing one.
  expect((await q.lookup(goodHash)).sequence).toBe("9");
  expect(attempts.slice(0, MAX_CONSECUTIVE_FAILURES)).toEqual(Array(MAX_CONSECUTIVE_FAILURES).fill(stuckHash));
  expect(attempts[MAX_CONSECUTIVE_FAILURES]).toBe(goodHash);

  const stats = q.stats();
  expect(stats.rotated).toBeGreaterThanOrEqual(1);
  expect(stats.submitted).toBe(1);
  expect(stats.failed).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_FAILURES);
  // Nothing was dropped: the stuck receipt is still queued and still being retried.
  expect(q.pending()).toBe(1);
  expect((await q.lookup(stuckHash)).sequence).toBeNull();
});

test("a lone failing receipt is retried in place and never counted as rotated", async () => {
  // With nothing behind it there is no queue to unblock, so rotating would be a no-op —
  // and reporting one would tell an operator the queue was making progress when it isn't.
  let calls = 0;
  const submit = async () => {
    calls++;
    if (calls <= MAX_CONSECUTIVE_FAILURES + 2) throw new Error("boom");
    return { sequence: "5", consensusTimestamp: "5.000" };
  };
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 1, fetchImpl: emptyMirrorPage });
  const only = receiptN(301);
  q.enqueue(only);
  await new Promise(res => setTimeout(res, 300));
  expect((await q.lookup(receiptHash(only))).sequence).toBe("5");
  expect(q.stats().rotated).toBe(0);
  expect(q.stats().submitted).toBe(1);
});
