import { Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import { canonicalize, fromB64, fromUtf8, receiptHash, type Receipt } from "@vaultradar/core";
import type { Config } from "./config";

export type LookupResult = {
  receipt_hash: string;
  topicId: string;
  sequence: string | null;
  consensus_timestamp: string | null;
  initial_transaction_id: string | null;
};

type Submit = (message: string) => Promise<{ sequence: string; consensusTimestamp: string; transactionId?: string }>;
type FetchLike = (url: string) => Promise<Response>;

const defaultFetch: FetchLike = url => fetch(url);

/**
 * Background commitment queue for HCS receipt anchoring (spec §5.5). `enqueue` is
 * synchronous and returns immediately — it only pushes onto an in-memory list and
 * kicks off (or lets an already-running) drain loop — so a slow or failing HCS submit
 * never blocks the HTTP response for the paid request the receipt belongs to. `drain`
 * retries the same head-of-queue message forever on failure (fixed delay) rather than
 * dropping it, since a receipt commitment is meant to be durable; only a successful
 * submit advances the queue.
 */
export class HcsQueue {
  private done = new Map<string, LookupResult>();
  private q: Receipt[] = [];
  private running = false;
  private retryMs: number;
  private fetchImpl: FetchLike;

  constructor(private deps: { submit: Submit; topicId: string; retryMs?: number; fetchImpl?: FetchLike }) {
    this.retryMs = deps.retryMs ?? 2000;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
  }

  /** Number of receipts submitted but not yet durably committed (queued or mid-retry). */
  pending(): number {
    return this.q.length;
  }

  enqueue(r: Receipt): void {
    this.q.push(r);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.q.length) {
      const r = this.q[0];
      const h = receiptHash(r);
      try {
        const message = canonicalize({ v: 1, receipt_hash: h, sig: r.sig, issued_at: r.issued_at });
        const res = await this.deps.submit(message);
        this.done.set(h, {
          receipt_hash: h,
          topicId: this.deps.topicId,
          sequence: res.sequence,
          consensus_timestamp: res.consensusTimestamp,
          initial_transaction_id: res.transactionId ?? null,
        });
        this.q.shift();
      } catch {
        // Leave the message at the head of the queue and retry after a delay.
        await new Promise(resolve => setTimeout(resolve, this.retryMs));
      }
    }
    this.running = false;
  }

  /**
   * In-memory record first (this process actually submitted it this run); else the
   * mirror node, for a receipt committed before this process's last restart (the
   * in-memory map does not survive one); else a null-sequence record. Never throws.
   */
  async lookup(h: string): Promise<LookupResult> {
    const hit = this.done.get(h);
    if (hit) return hit;
    const mirrored = await mirrorLookup(this.deps.topicId, h, this.fetchImpl);
    return mirrored ?? { receipt_hash: h, topicId: this.deps.topicId, sequence: null, consensus_timestamp: null, initial_transaction_id: null };
  }
}

/**
 * Minimal shape this module needs from a (possibly auto-chunking)
 * `TopicMessageSubmitTransaction` and its per-chunk `TransactionResponse`s — narrowed so
 * a test can inject a fake without touching the real Hedera SDK or network.
 */
type ChunkResponse = {
  transactionId: { toString(): string };
  getReceipt(client: Client): Promise<{ topicSequenceNumber?: { toString(): string } | null }>;
  getRecord(client: Client): Promise<{ consensusTimestamp: { toString(): string } }>;
};
type ChunkedSubmitTx = {
  setTopicId(id: TopicId): ChunkedSubmitTx;
  setMessage(message: string): ChunkedSubmitTx;
  executeAll(client: Client): Promise<ChunkResponse[]>;
};

/** Builds the operator-authenticated submit function `HcsQueue` uses in production.
 * `deps.client`/`deps.makeTx` exist purely so tests can inject fakes for both; production
 * callers never set them. */
export function makeHederaSubmit(c: Config, deps: { client?: Client; makeTx?: () => ChunkedSubmitTx } = {}): Submit {
  const client = deps.client ?? Client.forTestnet().setOperator(c.hedera.operatorId, PrivateKey.fromStringECDSA(c.hedera.operatorKey));
  const makeTx = deps.makeTx ?? (() => new TopicMessageSubmitTransaction() as unknown as ChunkedSubmitTx);
  return async message => {
    // The receipt commitment message (spec §5.5) is ~4.6 KB, well over HCS's ~1 KB
    // per-chunk limit, so this always auto-chunks. `TopicMessageSubmitTransaction.execute()`
    // returns only the *first* chunk's response ((await this.executeAll(client))[0],
    // confirmed in @hashgraph/sdk's own source) — using it directly would report chunk 1's
    // sequence/consensus timestamp for every submission, while `mirrorLookup` (which has no
    // such shortcut — it must wait for every chunk to arrive) reports the *last* chunk as
    // canonical, so the same receipt would describe two different (sequence,
    // consensus_timestamp) pairs depending on whether it was looked up from the in-memory
    // map or the mirror node. Fixed by calling `executeAll` directly and taking:
    //   - the LAST response's receipt/record for sequence and consensus timestamp, matching
    //     mirrorLookup's own choice — the message isn't complete (and so not truly
    //     "committed" as a whole) until its last chunk lands.
    //   - the FIRST response's transaction id for `transactionId`, since that id is exactly
    //     the `chunk_info.initial_transaction_id` the mirror node groups chunks by — the id
    //     a caller actually needs to find this message's chunks there.
    const responses = await makeTx().setTopicId(TopicId.fromString(c.hedera.hcsTopicId!)).setMessage(message).executeAll(client);
    const first = responses[0];
    const last = responses[responses.length - 1];
    const rc = await last.getReceipt(client);
    const record = await last.getRecord(client);
    return {
      sequence: rc.topicSequenceNumber?.toString() ?? "0",
      consensusTimestamp: record.consensusTimestamp.toString(),
      transactionId: first.transactionId.toString(),
    };
  };
}

type MirrorTxId = { account_id: string; nonce: number; scheduled: boolean; transaction_valid_start: string };
type MirrorChunkInfo = { initial_transaction_id: MirrorTxId; number: number; total: number } | null;
type MirrorMessage = {
  chunk_info: MirrorChunkInfo;
  consensus_timestamp: string;
  message: string; // base64
  sequence_number: number;
  topic_id: string;
};
type MirrorPage = { messages?: MirrorMessage[]; links?: { next: string | null } };

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com";
const MIRROR_MAX_PAGES = 5;

const txIdString = (t: MirrorTxId): string => `${t.account_id}@${t.transaction_valid_start}`;

/**
 * Scans a topic's messages on the public mirror node for one whose (possibly
 * chunked-and-reassembled) body is `{ v: 1, receipt_hash, ... }` with a matching hash.
 * Pages newest-first, following `links.next` up to `MIRROR_MAX_PAGES` pages (500
 * messages) — a receipt committed further back than that is not found via this
 * fallback; the in-memory map on `HcsQueue` is the fast path, this exists only for the
 * post-restart case. Never throws: any fetch/decode/parse failure yields `null`, same
 * as "not found", since a mirror-node hiccup should degrade to "unknown" rather than
 * fail the receipts route.
 */
export async function mirrorLookup(topicId: string, hash: string, fetchImpl: FetchLike = defaultFetch): Promise<LookupResult | null> {
  try {
    const groups = new Map<string, MirrorMessage[]>();
    let url: string | null = `${MIRROR_BASE}/api/v1/topics/${topicId}/messages?limit=100&order=desc`;
    for (let page = 0; page < MIRROR_MAX_PAGES && url; page++) {
      const res = await fetchImpl(url);
      if (!res.ok) break;
      const data = (await res.json()) as MirrorPage;
      for (const m of data.messages ?? []) {
        const key = m.chunk_info ? `c:${txIdString(m.chunk_info.initial_transaction_id)}` : `s:${m.sequence_number}`;
        const arr = groups.get(key);
        if (arr) arr.push(m);
        else groups.set(key, [m]);
      }
      const next = data.links?.next ?? null;
      url = next ? (next.startsWith("http") ? next : `${MIRROR_BASE}${next}`) : null;
    }

    for (const msgs of groups.values()) {
      const total = msgs[0].chunk_info?.total ?? 1;
      if (msgs.length !== total) continue; // incomplete: split further back than we paged, or a genuine partial group
      const ordered = [...msgs].sort((a, b) => (a.chunk_info?.number ?? 1) - (b.chunk_info?.number ?? 1));

      let text: string;
      try {
        const chunks = ordered.map(m => fromB64(m.message));
        const totalLen = chunks.reduce((n, c) => n + c.length, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          combined.set(c, offset);
          offset += c.length;
        }
        text = fromUtf8(combined);
      } catch {
        continue; // not valid base64 — not one of our messages
      }

      let parsed: { receipt_hash?: string } | null;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // not JSON — not one of our messages
      }
      if (parsed?.receipt_hash !== hash) continue;

      const last = ordered[ordered.length - 1];
      return {
        receipt_hash: hash,
        topicId,
        sequence: String(last.sequence_number),
        consensus_timestamp: last.consensus_timestamp,
        initial_transaction_id: last.chunk_info ? txIdString(last.chunk_info.initial_transaction_id) : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
