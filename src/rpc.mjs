// JSON-RPC client for the Pharos public endpoint.
//
// Two behaviours are load-bearing, both discovered by probing the real endpoint
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

  async function callOnce(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const body = await res.text().catch(() => "");
        throw new RpcError(`rate limited on ${method}: ${body.slice(0, 120)}`, {
          retryable: true,
          status: 429,
        });
      }
      if (res.status >= 500) {
        const body = await res.text().catch(() => "");
        throw new RpcError(`${method} failed with HTTP ${res.status}: ${body.slice(0, 120)}`, {
          retryable: true,
          status: res.status,
        });
      }

      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RpcError(`${method} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`, {
          status: res.status,
        });
      }

      if (payload.error) {
        const code = payload.error.code ?? null;
        const message = payload.error.message || "rpc error";
        throw new RpcError(`${method}: ${message}`, {
          code,
          status: res.status,
          retryable: RETRYABLE_CODES.has(code),
        });
      }
      if (!("result" in payload)) {
        throw new RpcError(`${method} returned neither result nor error`);
      }
      return payload.result;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      // Abort and transport failures are both worth another attempt.
      throw new RpcError(`${method} transport failure: ${e.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
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

  // Convenience wrappers. `scan` itself only uses `call`, which is what lets the
  // whole pipeline run against a fake chain in the offline tests — but these are
  // what the live tests and the verify script read directly.
  return {
    call,
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
