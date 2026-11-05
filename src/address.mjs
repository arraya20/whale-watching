// EIP-55 checksum only. No normalisation of mixed-case input.
//
// Whale tracking reads addresses off the chain in whatever casing the RPC
// returns (usually lowercase), so the checksum is computed here rather than
// verified. Verification matters for the one address this tool accepts from a
// human: a watchlist entry. A mistyped watch address means silently watching the
// wrong wallet, which looks identical to "that wallet was quiet".

import { keccak256Hex } from "./keccak.mjs";

const BODY = /^0x[0-9a-fA-F]{40}$/;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** EIP-55 casing for any 20-byte hex address. */
export function toChecksumAddress(address) {
  const lower = String(address).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not a 20-byte address: ${address}`);
  const hash = keccak256Hex(lower).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * Validate an operator-supplied address and return its canonical casing.
 * Mixed case is treated as a checksum claim and verified; lowercase or
 * uppercase input carries no claim and is accepted.
 *
 * @returns {{ok: true, address: string} | {ok: false, error: string}}
 */
export function normalizeAddress(input) {
  if (typeof input !== "string") return { ok: false, error: "address must be a string" };
  const s = input.trim();
  if (!BODY.test(s)) {
    if (/^0x[0-9a-fA-F]*$/.test(s) && s.length !== 42) {
      return { ok: false, error: `address must be 42 characters, got ${s.length}: "${s}"` };
    }
    return { ok: false, error: `not a 0x-prefixed 20-byte hex address: "${s}"` };
  }

  const body = s.slice(2);
  const canonical = toChecksumAddress(s);
  const allLower = body === body.toLowerCase();
  const allUpper = body === body.toUpperCase();
  if (allLower || allUpper) return { ok: true, address: canonical };

  if (s !== canonical) {
    return {
      ok: false,
      error:
        `EIP-55 checksum mismatch for "${s}"; the correct casing is "${canonical}". ` +
        `One character is wrong — watching this address would silently watch the wrong wallet.`,
    };
  }
  return { ok: true, address: canonical };
}

export const isZeroAddress = (a) => String(a).toLowerCase() === ZERO_ADDRESS;
