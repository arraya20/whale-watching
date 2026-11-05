// Chunked event scanning.
//
// The endpoint refuses a range wider than 1000 blocks (verified: 1000 inclusive
// works, 1001 returns -32602 "The block range is too large"). A window measured
// in hours is therefore always a sequence of chunks, which means a scan can end
// up with a hole in it.
//
// That hole is the whole reason this file exists. A scanner that drops failed
// chunks and returns the rest looks exactly like a quiet market: zero findings,
// HTTP 200. "Nothing happened" and "I could not look" must never be the same
// answer, so failures are collected and surfaced, and the caller decides whether
// what came back is usable.

export const MAX_BLOCK_SPAN = 1000; // inclusive, confirmed against the endpoint

/**
 * Split an inclusive block range into chunks the endpoint will accept.
 * @returns {Array<{fromBlock: number, toBlock: number}>}
 */
export function planChunks(fromBlock, toBlock, maxSpan = MAX_BLOCK_SPAN) {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
    throw new TypeError("block bounds must be integers");
  }
  if (fromBlock > toBlock) throw new RangeError(`empty range: ${fromBlock} > ${toBlock}`);
  if (!Number.isInteger(maxSpan) || maxSpan < 1 || maxSpan > MAX_BLOCK_SPAN) {
    throw new RangeError(`maxSpan must be between 1 and ${MAX_BLOCK_SPAN}`);
  }

  const chunks = [];
  for (let start = fromBlock; start <= toBlock; start += maxSpan) {
    chunks.push({ fromBlock: start, toBlock: Math.min(start + maxSpan - 1, toBlock) });
  }
  return chunks;
}

const hex = (n) => "0x" + n.toString(16);

/**
 * Fetch logs for one chunk. Throws on failure; the caller records it.
 */
export async function fetchChunk(rpc, { fromBlock, toBlock }, topics) {
  const result = await rpc.call("eth_getLogs", [{ fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics }]);
  if (!Array.isArray(result)) {
    throw new Error(`eth_getLogs returned ${typeof result}, expected an array`);
  }
  return result;
}

/**
 * Scan a full range, chunk by chunk.
 *
 * Returns everything that came back plus an explicit record of what did not.
 * `partial` is true whenever at least one chunk failed; `complete` says whether
 * the whole range was read.
 *
 * @returns {Promise<{
 *   logs: object[],
 *   chunksPlanned: number,
 *   chunksRead: number,
 *   blocksRead: number,
 *   failedChunks: Array<{fromBlock:number,toBlock:number,error:string}>,
 *   partial: boolean,
 * }>}
 */
export async function scanRange(rpc, { fromBlock, toBlock, topics, maxSpan = MAX_BLOCK_SPAN, onChunk }) {
  const chunks = planChunks(fromBlock, toBlock, maxSpan);
  const logs = [];
  const failedChunks = [];
  let blocksRead = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const batch = await fetchChunk(rpc, chunk, topics);
      logs.push(...batch);
      blocksRead += chunk.toBlock - chunk.fromBlock + 1;
    } catch (e) {
      failedChunks.push({ fromBlock: chunk.fromBlock, toBlock: chunk.toBlock, error: e.message });
    }
    if (onChunk) onChunk({ chunk, read: i + 1, total: chunks.length });
  }

  return {
    logs,
    chunksPlanned: chunks.length,
    chunksRead: chunks.length - failedChunks.length,
    blocksRead,
    failedChunks,
    partial: failedChunks.length > 0,
  };
}
