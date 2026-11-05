// Byte and word decoding for log data.
//
// Every quantity that leaves this file is a BigInt or a decimal string. Log data
// is 32-byte words; a topic is a 32-byte word whose last 20 bytes are an address.
// Decoding by hand keeps the failure modes explicit — a short `data` payload, a
// missing topic, or an odd-length hex string is reported, not coerced.

const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;

/** @returns {boolean} true for a 0x-prefixed, even-length hex string (data). */
export function isHex(value) {
  return typeof value === "string" && HEX.test(value) && value.length % 2 === 0;
}

/** Strip 0x and lowercase. Does not validate. */
export const bareHex = (value) => String(value).replace(/^0x/i, "").toLowerCase();

/**
 * Decode an unsigned integer from a 0x-prefixed hex quantity.
 *
 * Quantities are not byte strings: `eth_blockNumber` legitimately returns "0x0",
 * which has an odd number of digits. Requiring even length here rejected real
 * values from the endpoint, so the check is on the shape of a quantity, not on
 * word alignment.
 *
 * @returns {bigint}
 */
export function decodeUint(hex) {
  if (typeof hex !== "string" || !QUANTITY.test(hex)) {
    throw new Error(`not a hex quantity: ${JSON.stringify(hex)}`);
  }
  return BigInt(hex);
}

/**
 * Decode the single 32-byte word of `data` produced by a Transfer event.
 * A token that appends extra data is refused rather than truncated: the first
 * word would look right while the contract meant something else.
 *
 * @returns {{ok: true, amount: bigint} | {ok: false, reason: string}}
 */
export function decodeSingleWord(data) {
  if (!isHex(data)) return { ok: false, reason: "DATA_NOT_HEX" };
  const body = bareHex(data);
  if (body.length !== 64) return { ok: false, reason: "DATA_NOT_ONE_WORD" };
  return { ok: true, amount: BigInt("0x" + body) };
}

/**
 * An indexed address topic is a 32-byte word with 12 leading zero bytes.
 * A topic that sets those bytes is not an address; refuse instead of masking,
 * because masking would silently turn an unrelated value into an address.
 *
 * @returns {{ok: true, address: string} | {ok: false, reason: string}}
 */
export function decodeAddressTopic(topic) {
  if (!isHex(topic)) return { ok: false, reason: "TOPIC_NOT_HEX" };
  const body = bareHex(topic);
  if (body.length !== 64) return { ok: false, reason: "TOPIC_NOT_ONE_WORD" };
  if (!/^0{24}$/.test(body.slice(0, 24))) return { ok: false, reason: "TOPIC_DIRTY_PADDING" };
  return { ok: true, address: "0x" + body.slice(24) };
}

/** Left-pad a value to a 32-byte hex word, for building eth_call payloads. */
export function toWord(value) {
  const v = typeof value === "bigint" ? value : BigInt(value);
  return v.toString(16).padStart(64, "0");
}
