// JSON-RPC client for the Pharos public endpoint.
//
// Three behaviours are load-bearing, all discovered by probing the real endpoint
// rather than reading docs:
//
// 1. `eth_getLogs` refuses a block range wider than 1000 blocks
//    ("The block range is too large"). Scanning therefore has to be chunked, and
//    a chunk can fail on its own — so a scan is a sequence of results with a
//    possible hole, never a single all-or-nothing read.
//
// 2. The endpoint enforces a compute-unit budget per second and answers 429 with
//    `cu limit exceeded`. A naive loop over 40 chunks reliably trips it. Requests
//    are therefore serialised with a minimum interval and retried with backoff.
//
// 3. Native PROS has no log; reading it means one `eth_getBlockByNumber(n, true)`
//    per block, which is thousands of calls. The endpoint answers JSON-RPC
//    batches, so block reads are batched 100-at-a-time instead of issued one by
//    one. A batch can fail per item, so batch results are per item, not a bare
//    array that would hide which block failed.
//
// Anything unrecoverable is raised as RpcError so callers can decide between
// "the chain is unreadable" and "the answer is no". Those are different answers
// and must never collapse into one.

export class RpcError extends Error {
  constructor(message, { code = null, retryable = false, status = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const RETRYABLE_CODES = new Set([-32011, -32005, -32603]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} options
 * @param {string} options.url
 * @param {number} [options.minIntervalMs] spacing between requests
 * @param {number} [options.maxAttempts]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [options.sleep]
 */
export function createRpc({
  url,
  minIntervalMs = 120,
  maxAttempts = 6,
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
} = {}) {
  if (!url) throw new Error("rpc url is required");

  let gate = Promise.resolve();
  let nextSlot = 0;

  // Serialises requests and spaces them out. Without this the endpoint starts
  // answering 429 partway through a multi-chunk scan and the scan silently ends
  // up short.
  function schedule() {
    const run = gate.then(async () => {
      const now = Date.now();
      if (now < nextSlot) await sleep(nextSlot - now);
      nextSlot = Date.now() + minIntervalMs;
    });
    gate = run.catch(() => {});
    return run;
  }

  let id = 0;

  // One HTTP POST, shared by single and batch requests. Returns the decoded JSON
  // payload (object for a single call, array for a batch) plus the HTTP status.
  // Transport, abort, throttle and 5xx are all raised as retryable RpcError.
  async function post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const text = await res.text().catch(() => "");
        throw new RpcError(`rate limited: ${text.slice(0, 120)}`, {
          retryable: true,
          status: 429,
        });
      }
      if (res.status >= 500) {
        const text = await res.text().catch(() => "");
        throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 120)}`, {
          retryable: true,
          status: res.status,
        });
      }

      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RpcError(`non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`, {
          status: res.status,
        });
      }
      return { payload, status: res.status };
    } catch (e) {
      if (e instanceof RpcError) throw e;
      // Abort and transport failures are both worth another attempt.
      throw new RpcError(`transport failure: ${e.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async function callOnce(method, params) {
    const { payload, status } = await post({ jsonrpc: "2.0", id: ++id, method, params });
    if (payload.error) {
      const code = payload.error.code ?? null;
      const message = payload.error.message || "rpc error";
      throw new RpcError(`${method}: ${message}`, {
        code,
        status,
        retryable: RETRYABLE_CODES.has(code),
      });
    }
    if (!("result" in payload)) {
      throw new RpcError(`${method} returned neither result nor error`);
    }
    return payload.result;
  }

  // One batch body -> per-item results. Per-item errors are surfaced in place,
  // never flattened into a bare array, so the caller can tell which block failed.
  async function batchOnce(calls) {
    const body = calls.map((c, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: c.method,
      params: c.params ?? [],
    }));
    const { payload } = await post(body);
    if (!Array.isArray(payload)) {
      if (payload && payload.error) {
        const code = payload.error.code ?? null;
        throw new RpcError(`batch: ${payload.error.message || "rpc error"}`, {
          code,
          retryable: RETRYABLE_CODES.has(code),
        });
      }
      throw new RpcError("batch returned non-array");
    }
    const byId = new Map();
    for (const item of payload) {
      if (item && typeof item === "object" && item.id !== undefined) byId.set(item.id, item);
    }
    return calls.map((_, i) => {
      const item = byId.get(i + 1);
      if (!item) return { ok: false, code: "MISSING", message: "no response for this batch item" };
      if (item.error) {
        return {
          ok: false,
          code: item.error.code ?? "RPC_ERROR",
          message: String(item.error.message ?? "rpc error"),
        };
      }
      return { ok: true, value: item.result };
    });
  }

  async function call(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await schedule();
      try {
        return await callOnce(method, params);
      } catch (e) {
        lastError = e;
        if (!e.retryable) throw e;
        if (attempt === maxAttempts - 1) break;
        await sleep(Math.min(3000, 400 * 2 ** attempt));
      }
    }
    // Carry the cause's classification forward. Dropping `retryable` here made a
    // gave-up throttle indistinguishable from a contract that answered nothing,
    // which is the difference between "unavailable" and "not an ERC-20".
    throw new RpcError(`${method} gave up after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}`, {
      code: lastError?.code ?? null,
      status: lastError?.status ?? null,
      retryable: lastError?.retryable === true,
    });
  }

  async function batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return [];
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await schedule();
      try {
        return await batchOnce(calls);
      } catch (e) {
        lastError = e;
        if (!e.retryable) throw e;
        if (attempt === maxAttempts - 1) break;
        await sleep(Math.min(3000, 400 * 2 ** attempt));
      }
    }
    throw new RpcError(`batch gave up after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}`, {
      code: lastError?.code ?? null,
      status: lastError?.status ?? null,
      retryable: lastError?.retryable === true,
    });
  }

  // Convenience wrappers. `scan` itself only uses `call` and `batch`, which is
  // what lets the whole pipeline run against a fake chain in the offline tests —
  // but these are what the live tests and the verify script read directly.
  return {
    call,
    batch,
    url,
    getChainId: async () => decodeQuantity(await call("eth_chainId", [])),
    getBlockNumber: async () => decodeQuantity(await call("eth_blockNumber", [])),
  };
}

/** Hex quantity -> BigInt. Rejects anything that is not 0x-prefixed hex. */
export function decodeQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new RpcError(`expected a hex quantity, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}
