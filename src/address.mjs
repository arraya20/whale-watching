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

// Canonical contracts on Pharos Pacific (chain 1672), confirmed on-chain via
// eth_getCode and symbol()/decimals(). Used for labelling counterparties and
// as the default configurable watchlist.
export const KNOWN_LABELS = Object.freeze({
  [ZERO_ADDRESS]: "Zero Address",
  "0xc879c018db60520f4355c26ed1a6d572cdac1815": "USDC Token",
  "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0": "WPROS Token",
  "0x1f4b7011ee3d53969bb67f59428a9ec0477856e9": "WETH Token",
  "0x51e2a24742db77604b881d6781ee16b5b8fcbe29": "LINK Token",
  "0x6b0a44c64190279f7034b77c13a566e914fe5ec4": "stPROS Token",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "ERC-4337 EntryPoint v0.7",
  "0xca11bde05977b3631167028862be2a173976ca11": "Multicall3",
  "0x707e665b1a46319ab82af7e300f0c92b3a279325": "PROPRO Active Mover",
  "0x75e54acb9107cc35969b44eb6342f50686b3a12d": "PROPRO Liquidity Counterparty",
});

// Default 5 watched addresses (EIP-55), covering active Pharos movers and
// canonical protocol contracts. Callers can override or add up to 20 via ?watch=.
export const DEFAULT_WATCHLIST = Object.freeze([
  "0x707E665B1a46319AB82AF7E300F0c92b3a279325",
  "0x75E54ACb9107Cc35969b44Eb6342F50686b3A12d",
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0",
  "0xC879C018dB60520F4355C26eD1a6D572cdAC1815",
]);

/**
 * Resolve a known human-readable label for an address, or null if unknown.
 * Dynamic token symbols discovered during a scan take precedence over static
 * fallback only when the address is not in KNOWN_LABELS.
 *
 * @param {string} address
 * @param {Map<string, string>|Record<string, string>} [extraLabels]
 * @returns {string|null}
 */
export function labelAddress(address, extraLabels = null) {
  if (typeof address !== "string") return null;
  const key = address.toLowerCase();
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key];
  if (extraLabels) {
    if (extraLabels instanceof Map && extraLabels.has(key)) return extraLabels.get(key);
    if (typeof extraLabels === "object" && key in extraLabels) return extraLabels[key];
  }
  return null;
}

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
