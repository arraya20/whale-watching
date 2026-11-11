// Minimal test harness: a runner, assertions, and a fake chain.
//
// No framework, no dependencies, no network. The fake chain is an in-memory
// object that answers the same JSON-RPC methods the real endpoint does, so the
// scan logic is exercised offline — including the failure modes that only show
// up when a chunk fails or a token does not answer.

let passed = 0;
const failures = [];
let currentSuite = "";

export function suite(name) {
  currentSuite = name;
  console.log(`\n${name}`);
}

export async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ suite: currentSuite, name, error: e });
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(message ?? "assertion failed");
}

export function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? "values differ"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function throws(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message ?? "expected a throw");
}

export async function rejects(fn, message) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message ?? "expected a rejection");
}

export function report() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ${f.suite} > ${f.name}: ${f.error.stack}`);
    process.exitCode = 1;
  }
  return failures.length === 0;
}

// ---------------------------------------------------------------- fake chain

const hexOf = (n) => "0x" + BigInt(n).toString(16);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

export const SELECTOR = {
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  symbol: "0x95d89b41",
};

/** ABI-encode a string the way `symbol() returns (string)` does. */
export function encodeString(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const len = word(bytes.length);
  const body = bytes.map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
  return "0x" + word(32) + len + body;
}

/** ABI-encode a bytes32 symbol, as pre-standard tokens return it. */
export function encodeBytes32(text) {
  const bytes = [...new TextEncoder().encode(text)];
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function transferLog({ token, from, to, amount, block, logIndex = 0, txHash = null }) {
  const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");
  return {
    address: token,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: "0x" + word(amount),
    blockNumber: hexOf(block),
    logIndex: hexOf(logIndex),
    transactionHash: txHash ?? "0x" + word(block) + word(logIndex).slice(2, 26),
    removed: false,
  };
}

/**
 * @param {object} spec
 * @param {number} [spec.head]
 * @param {bigint|number} [spec.chainId]
 * @param {number} [spec.blockTime] seconds per block
 * @param {object[]} [spec.logs]
 * @param {Record<string,{symbol:string,decimals:number,totalSupply:bigint,bytes32?:boolean}>} [spec.tokens]
 * @param {Set<number>} [spec.failFrom] chunk start blocks whose getLogs must throw
 * @param {object} [spec.rawLogs] override eth_getLogs entirely
 * @param {Record<string,bigint|number|((block:bigint)=>bigint)>} [spec.balances] native balances by address
 * @param {object[]} [spec.nativeTxs] native transactions by block, each {from,to,value,block,txIndex?}
 * @param {Set<number>} [spec.failBlocks] blocks whose full-body read must throw
 */
export function fakeChain(spec = {}) {
  const {
    head = 5000,
    chainId = 1672n,
    blockTime = 6,
    logs = [],
    tokens = {},
    failFrom = new Set(),
    failTokens = new Set(),
    rawLogs = null,
    balances = {},
    nativeTxs = [],
    failBlocks = new Set(),
  } = spec;

  const calls = [];
  const timestampOf = (b) => BigInt(b) * BigInt(blockTime);

  function ethCall(params) {
    const { to, data } = params[0] ?? {};
    // Simulates the endpoint throttling a getter, which is not the same as the
    // contract answering nothing.
    if (failTokens.has(String(to).toLowerCase())) {
      throw Object.assign(new Error("cu limit exceeded"), { rpcCode: -32011, retryable: true });
    }
    const token = tokens[String(to).toLowerCase()];
    if (!token) return "0x";
    if (data === SELECTOR.decimals) return "0x" + word(token.decimals);
    if (data === SELECTOR.totalSupply) return "0x" + word(token.totalSupply);
    if (data === SELECTOR.symbol) return token.bytes32 ? encodeBytes32(token.symbol) : encodeString(token.symbol);
    return "0x";
  }

  function getLogs(params) {
    const { fromBlock, toBlock } = params[0] ?? {};
    const from = Number(BigInt(fromBlock));
    const to = Number(BigInt(toBlock));
    if (to - from + 1 > 1000) {
      throw Object.assign(new Error("The block range is too large"), { rpcCode: -32602 });
    }
    if (failFrom.has(from)) {
      throw Object.assign(new Error("cu limit exceeded"), { rpcCode: -32011, retryable: true });
    }
    return logs.filter((l) => {
      const b = Number(BigInt(l.blockNumber));
      return b >= from && b <= to;
    });
  }

  function getBalance(params) {
    const [addr, blockHex] = params;
    const entry = balances[String(addr).toLowerCase()];
    const at = blockHex == null ? 0n : BigInt(blockHex);
    if (typeof entry === "function") return hexOf(entry(at));
    if (typeof entry === "bigint") return hexOf(entry);
    if (typeof entry === "number") return hexOf(BigInt(entry));
    return "0x0";
  }

  function getBlockByNumber(params) {
    const b = Number(BigInt(params[0]));
    if (b < 0) return null;
    if (failBlocks.has(b)) {
      throw Object.assign(new Error("native block throttled"), { rpcCode: -32011, retryable: true });
    }
    const txns = params[1] === true
      ? nativeTxs
          .filter((t) => Number(BigInt(t.block ?? t.blockNumber)) === b)
          .map((t) => ({
            from: String(t.from).toLowerCase(),
            to: t.to != null ? String(t.to).toLowerCase() : null,
            value: hexOf(t.value),
            hash: t.hash ?? "0x" + BigInt(b).toString(16).padStart(64, "0"),
            transactionIndex: hexOf(t.txIndex ?? 0),
          }))
      : [];
    return { number: hexOf(b), timestamp: hexOf(timestampOf(b)), transactions: txns };
  }

  function dispatch(method, params) {
    switch (method) {
      case "eth_chainId":
        return hexOf(chainId);
      case "eth_blockNumber":
        return hexOf(head);
      case "eth_getBlockByNumber":
        return getBlockByNumber(params);
      case "eth_getLogs":
        if (rawLogs) return rawLogs(params[0]);
        return getLogs(params);
      case "eth_call":
        return ethCall(params);
      case "eth_getBalance":
        return getBalance(params);
      default:
        throw new Error(`fake chain does not implement ${method}`);
    }
  }

  async function call(method, params) {
    calls.push({ method, params });
    return dispatch(method, params);
  }

  // Per-item results, matching createRpc.batch's contract: a failed item is a
  // failed block, never a flattened array that hides which block failed.
  async function batch(list) {
    return list.map(({ method, params }) => {
      try {
        return { ok: true, value: dispatch(method, params) };
      } catch (e) {
        return { ok: false, code: e.rpcCode ?? "RPC_ERROR", message: e.message };
      }
    });
  }

  // fetch-shaped stub, for exercising the real createRpc + API handler.
  async function fetchStub(url, init) {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      const items = body.map((item) => {
        try {
          const result = dispatch(item.method, item.params);
          return { jsonrpc: "2.0", id: item.id, result };
        } catch (e) {
          return {
            jsonrpc: "2.0",
            id: item.id,
            error: { code: e.rpcCode ?? -32000, message: e.message },
          };
        }
      });
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    try {
      const result = dispatch(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e.rpcCode) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: e.rpcCode, message: e.message } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw e;
    }
  }

  return { call, batch, fetchStub, calls };
}

/** A Response-like object good enough for the API handler's json() helper. */
export function installFetch(fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = original;
  };
}
