// Token metadata, read from the chain and never assumed.
//
// The scaffold had no token registry at all — it printed every transfer in
// "PROS" with 18 decimals regardless of what the token actually was. That is the
// same class of error as a hardcoded registry: a number that is right for one
// token and wrong by orders of magnitude for the next.
//
// On this chain the spread is real: USDC has 6 decimals, BTCVP has 8, WPROS and
// pCARR have 18. Formatting a 6-decimal amount with 18 decimals divides it by
// 10^12, and the result still looks like a plausible number.
//
// So `decimals()`, `totalSupply()` and `symbol()` are read per token, cached for
// the duration of a scan, and a token that cannot be read is excluded with a
// stated reason. It is never guessed.

import { keccak256Hex } from "./keccak.mjs";
import { toChecksumAddress } from "./address.mjs";
import { isHex } from "./hex.mjs";

export const TRANSFER_TOPIC = keccak256Hex("Transfer(address,address,uint256)");

const SELECTORS = {
  decimals: keccak256Hex("decimals()").slice(0, 10),
  totalSupply: keccak256Hex("totalSupply()").slice(0, 10),
  symbol: keccak256Hex("symbol()").slice(0, 10),
};

/** Decode a `bytes32` symbol, as used by pre-standard tokens. */
function decodeBytes32String(body) {
  const text = body.replace(/(00)+$/, "");
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) return null;
  try {
    const bytes = new Uint8Array(text.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    const decoded = new TextDecoder().decode(bytes);
    return /^[\x20-\x7e]{1,32}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Decode an ABI `string` return value, or fall back to bytes32. */
export function decodeSymbol(hex) {
  if (!isHex(hex) || hex === "0x") return null;
  const body = hex.slice(2);

  if (body.length === 64) return decodeBytes32String(body); // bytes32 symbol

  if (body.length >= 128) {
    const offset = Number(BigInt("0x" + body.slice(0, 64)));
    if (offset * 2 + 64 <= body.length) {
      const len = Number(BigInt("0x" + body.slice(offset * 2, offset * 2 + 64)));
      const start = offset * 2 + 64;
      const data = body.slice(start, start + len * 2);
      if (data.length === len * 2) {
        try {
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
          const decoded = new TextDecoder().decode(bytes);
          return /^[\x20-\x7e]{1,32}$/.test(decoded) ? decoded : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const uintFrom = (hex) => {
  if (!isHex(hex) || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length !== 64) return null;
  return BigInt("0x" + body);
};

/**
 * True when the read failed because the endpoint could not answer, not because
 * the contract answered something unusable. RpcError already carries the
 * distinction; a bare throw (network, abort) is treated as transient too.
 */
function isTransientRpcError(e) {
  if (!e) return false;
  if (e.retryable === true) return true;
  if (e.status === 429 || (typeof e.status === "number" && e.status >= 500)) return true;
  if (e.name === "RpcError") return e.code === null;
  // Anything that is not an RPC verdict (network failure, abort, a decoder
  // throwing) is "we do not know", and unknown must not be reported as a
  // statement about the contract.
  return true;
}

/**
 * Read symbol/decimals/totalSupply for one token contract.
 *
 * @returns {Promise<{ok:true, token:object} | {ok:false, reason:string, address:string}>}
 */
export async function readToken(rpc, address) {
  // Each getter is read on its own. A single 429 used to fail all three through
  // Promise.all, which turned "the endpoint throttled us" into "this is not an
  // ERC-20" — a claim about the contract made from an answer we never got.
  const read = async (selector, decode) => {
    try {
      const raw = await rpc.call("eth_call", [{ to: address, data: selector }, "latest"]);
      return { ok: true, value: decode(raw) };
    } catch (e) {
      return { ok: false, transient: isTransientRpcError(e), error: e.message };
    }
  };

  const [d, s, sym] = await Promise.all([
    read(SELECTORS.decimals, uintFrom),
    read(SELECTORS.totalSupply, uintFrom),
    read(SELECTORS.symbol, (hex) => hex),
  ]);

  // Throttling first: "we could not ask" is not "the contract said nothing".
  const transientFailure = [d, s, sym].find((r) => !r.ok && r.transient);
  if (transientFailure) {
    return {
      ok: false,
      address,
      transient: true,
      reason: `METADATA_UNAVAILABLE: eth_call failed (${transientFailure.error.slice(0, 160)})`,
    };
  }
  for (const r of [d, s, sym]) {
    if (!r.ok) return { ok: false, address, transient: false, reason: `METADATA_INVALID: ${r.error.slice(0, 160)}` };
  }

  const decimals = d.value;
  const supply = s.value;

  if (decimals === null) return { ok: false, address, transient: false, reason: "DECIMALS_UNREADABLE" };
  if (decimals > 36n) return { ok: false, address, transient: false, reason: `DECIMALS_OUT_OF_RANGE: ${decimals}` };
  if (supply === null) return { ok: false, address, transient: false, reason: "TOTAL_SUPPLY_UNREADABLE" };
  if (supply === 0n) return { ok: false, address, transient: false, reason: "TOTAL_SUPPLY_ZERO" };

  const symbol = decodeSymbol(sym.value);
  if (symbol === null) return { ok: false, address, transient: false, reason: "SYMBOL_UNREADABLE" };

  return {
    ok: true,
    token: {
      address: toChecksumAddress(address),
      symbol,
      decimals: Number(decimals),
      totalSupplyRaw: supply,
    },
  };
}

/**
 * Memoised reader for one scan. Concurrent requests for the same token collapse
 * into one in-flight call, because a busy window can touch the same token in
 * hundreds of logs and the endpoint rate-limits aggressively.
 */
export function createTokenCache(rpc) {
  const done = new Map();
  const inFlight = new Map();

  async function get(address) {
    const key = address.toLowerCase();
    if (done.has(key)) return done.get(key);

    let promise = inFlight.get(key);
    if (!promise) {
      promise = readToken(rpc, key).then((result) => {
        done.set(key, result);
        inFlight.delete(key);
        return result;
      });
      inFlight.set(key, promise);
    }
    return promise;
  }

  return {
    get,
    get size() {
      return done.size;
    },
    entries: () => [...done.entries()],
  };
}
