// Native PROS tracking.
//
// ERC-20 movement is read from `Transfer` logs, but native PROS has no log: a
// transaction's `value` exists only in the block body. Native movement is
// therefore read from `eth_getBlockByNumber(n, true)` and filtered to the
// transactions that pay or collect a watched address. There is no standard
// JSON-RPC method that answers "which native transfers touched this address", so
// the block body is the only honest source.
//
// Reading thousands of blocks one at a time would blow both the request budget
// and the endpoint's compute-unit limit, so blocks are fetched in JSON-RPC
// batches. A failed block is a hole in the native ledger and is reported, never
// silently dropped.

import { decodeUint } from "./hex.mjs";
import { toChecksumAddress } from "./address.mjs";
import { formatRaw, formatRawShort } from "./numbers.mjs";

export const NATIVE_SYMBOL = "PROS";
export const NATIVE_DECIMALS = 18;
export const NATIVE_BATCH_SIZE = 100;
export const NATIVE_CONCURRENCY = 2;
// Native reads are heavier than a log range, so they are capped well below the
// ERC-20 window cap. Full block bodies are fetched one JSON-RPC batch per 100
// blocks and serialised against the same rate limiter as every other call; a
// large cap turns a scan into dozens of sequential full-block batches that push
// a Workers request past Cloudflare's 100s wall timeout (HTTP 524). 600 blocks
// is a measured, safe ceiling: ~6 batches, with the per-address balance delta
// still covering the full requested window.
export const NATIVE_MAX_BLOCKS = 600;

const QUANTITY = /^0x[0-9a-fA-F]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const hex = (n) => "0x" + n.toString(16);

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** @returns {"NATIVE_OUT"|"NATIVE_IN"|"NATIVE_SELF"} */
export function classifyNativeKind(fromWatched, toWatched) {
  if (fromWatched && toWatched) return "NATIVE_SELF";
  if (fromWatched) return "NATIVE_OUT";
  return "NATIVE_IN";
}

/**
 * Decode one transaction's native value.
 * A value of 0 is a contract call, not a movement, and is dropped.
 *
 * @returns {{ok:true, native:object} | {ok:false, reason:string}}
 */
export function decodeNativeTx(tx, blockNumber) {
  if (!tx || typeof tx !== "object") return { ok: false, reason: "TX_NOT_OBJECT" };

  const v = tx.value;
  let valueRaw = 0n;
  if (v != null && v !== "0x" && v !== "0x0") {
    if (typeof v !== "string" || !QUANTITY.test(v)) return { ok: false, reason: "VALUE_NOT_QUANTITY" };
    try {
      valueRaw = decodeUint(v);
    } catch {
      return { ok: false, reason: "VALUE_NOT_QUANTITY" };
    }
  }
  if (valueRaw === 0n) return { ok: false, reason: "ZERO_VALUE" };

  if (typeof tx.from !== "string" || !ADDRESS.test(tx.from)) return { ok: false, reason: "BAD_FROM" };
  if (tx.to != null && (typeof tx.to !== "string" || !ADDRESS.test(tx.to))) {
    return { ok: false, reason: "BAD_TO" };
  }

  let txIndex = 0;
  if (tx.transactionIndex != null) {
    try {
      txIndex = Number(decodeUint(tx.transactionIndex));
    } catch {
      txIndex = 0;
    }
  }

  return {
    ok: true,
    native: {
      from: tx.from.toLowerCase(),
      to: tx.to != null ? tx.to.toLowerCase() : null,
      valueRaw,
      blockNumber,
      txIndex,
      txHash: typeof tx.hash === "string" ? tx.hash : null,
    },
  };
}

/**
 * Read block bodies over a range and return native transfers touching a watched
 * address. Failures are collected per block; a failed batch is one gap, not one
 * gap per block.
 *
 * @param {object} rpc must expose `batch`
 * @returns {Promise<{transfers:object[], blocksPlanned:number, blocksRead:number, failedChunks:object[], partial:boolean}>}
 */
export async function scanNative(rpc, { fromBlock, toBlock, watched, batchSize = NATIVE_BATCH_SIZE, concurrency = NATIVE_CONCURRENCY }) {
  const watchedLower = new Set(watched.map((a) => a.toLowerCase()));

  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    ranges.push([start, Math.min(start + batchSize - 1, toBlock)]);
  }

  const transfers = [];
  const failedChunks = [];
  let blocksRead = 0;

  const perChunk = await mapWithConcurrency(ranges, concurrency, async ([a, b]) => {
    const calls = [];
    for (let n = a; n <= b; n++) calls.push({ method: "eth_getBlockByNumber", params: [hex(n), true] });
    try {
      return { a, b, items: await rpc.batch(calls) };
    } catch (e) {
      return { a, b, items: null, error: e };
    }
  });

  for (const { a, b, items, error } of perChunk) {
    if (!items) {
      failedChunks.push({ fromBlock: a, toBlock: b, error: error?.message ?? "batch failed" });
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      const n = a + i;
      const item = items[i];
      if (!item.ok) {
        failedChunks.push({ fromBlock: n, toBlock: n, error: `rpc ${item.code}: ${item.message}` });
        continue;
      }
      const blk = item.value;
      if (!blk || typeof blk !== "object") {
        failedChunks.push({ fromBlock: n, toBlock: n, error: "block missing from response" });
        continue;
      }
      blocksRead++;
      for (const tx of Array.isArray(blk.transactions) ? blk.transactions : []) {
        const decoded = decodeNativeTx(tx, n);
        if (!decoded.ok) continue;
        const f = decoded.native;
        const fromWatched = watchedLower.has(f.from);
        const toWatched = f.to != null && watchedLower.has(f.to);
        if (!fromWatched && !toWatched) continue;
        transfers.push({ ...f, direction: classifyNativeKind(fromWatched, toWatched) });
      }
    }
  }

  return {
    transfers,
    fromBlock,
    toBlock,
    blocksPlanned: toBlock - fromBlock + 1,
    blocksRead,
    failedChunks,
    partial: failedChunks.length > 0,
  };
}

const fmtParty = (addr, label) => (label ? `${addr} (${label})` : addr);

function describeNative({ kind, amount, from, fromLabel, to, toLabel }) {
  if (kind === "NATIVE_OUT") {
    const dest = to ? fmtParty(to, toLabel) : "a new contract";
    return `Sent ${amount} ${NATIVE_SYMBOL} from ${fmtParty(from, fromLabel)} to ${dest}`;
  }
  if (kind === "NATIVE_IN") {
    return `Received ${amount} ${NATIVE_SYMBOL} from ${fmtParty(from, fromLabel)} to ${fmtParty(to, toLabel)}`;
  }
  return `Self-transferred ${amount} ${NATIVE_SYMBOL} at ${fmtParty(from, fromLabel)}`;
}

/**
 * Turn a decoded native transfer into a finding-shaped object. `resolveLabel`
 * supplies the same counterparty labels the ERC-20 path uses. Native has no
 * token contract and no supply, so those fields are null; the shape stays
 * compatible with the dashboard renderer.
 */
export function buildNativeFinding(native, resolveLabel = null) {
  const from = toChecksumAddress(native.from);
  const to = native.to != null ? toChecksumAddress(native.to) : null;
  const fromLabel = resolveLabel ? resolveLabel(from) : null;
  const toLabel = to && resolveLabel ? resolveLabel(to) : null;
  const fromWatched = native.direction === "NATIVE_OUT" || native.direction === "NATIVE_SELF";
  const toWatched = native.direction === "NATIVE_IN" || native.direction === "NATIVE_SELF";
  const kind = classifyNativeKind(fromWatched, toWatched);
  const amount = formatRawShort(native.valueRaw, NATIVE_DECIMALS, 6);
  const amountExact = formatRaw(native.valueRaw, NATIVE_DECIMALS);

  return {
    token: { address: null, symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS, totalSupply: null },
    kind,
    direction: native.direction,
    from,
    fromLabel,
    to,
    toLabel,
    amountRaw: native.valueRaw.toString(),
    amount,
    amountExact,
    explanation: describeNative({ kind, amount, from, fromLabel, to, toLabel }),
    blockNumber: native.blockNumber,
    txIndex: native.txIndex,
    txHash: native.txHash,
  };
}
