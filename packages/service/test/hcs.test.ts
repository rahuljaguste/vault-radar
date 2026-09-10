import { expect, test } from "bun:test";
import { buildReceipt, canonicalize, deriveSigningKeys, receiptHash } from "@vaultradar/core";
import { HcsQueue, mirrorLookup } from "../src/hcs";

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
  const submit = () => new Promise<never>(() => {}); // never resolves — proves nothing here waits on it
  const q = new HcsQueue({ submit, topicId: "0.0.5", fetchImpl: emptyMirrorPage });
  const returned = q.enqueue(r);
  expect(returned).toBeUndefined();
  // Observable synchronously right after the call returns, with no await in between —
  // this is what lets a route's settlement hook call enqueue() and move on without
  // ever blocking the response that already went out.
  expect(q.pending()).toBe(1);
});

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
