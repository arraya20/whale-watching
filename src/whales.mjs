// Turning a raw `Transfer` log into a verified finding.
//
// A log is only accepted when every part of it decodes. Anything else is counted
// under a reason and left out of the ranking, because a half-decoded transfer is
// worse than an absent one: it would appear in the list with a plausible amount
// and an amount that is not the one the contract emitted.
//
// A reorg is handled explicitly — logs flagged `removed` are dropped, not ranked.

import { decodeUint, decodeSingleWord, decodeAddressTopic } from "./hex.mjs";
import { toChecksumAddress, ZERO_ADDRESS, labelAddress } from "./address.mjs";
import { formatRaw, formatRawShort } from "./numbers.mjs";
import { shareBps, sharePercent } from "./share.mjs";
import { TRANSFER_TOPIC } from "./tokens.mjs";

/**
 * A transfer that creates tokens (from the zero address) or destroys them is
 * still a whale-scale event, and usually a more interesting one than a plain
 * move. It is labelled rather than filtered.
 */
export function classifyKind(from, to) {
  const fromZero = from.toLowerCase() === ZERO_ADDRESS;
  const toZero = to.toLowerCase() === ZERO_ADDRESS;
  if (fromZero && toZero) return "NULL";
  if (fromZero) return "MINT";
  if (toZero) return "BURN";
  if (from.toLowerCase() === to.toLowerCase()) return "SELF";
  return "TRANSFER";
}

/**
 * @returns {{ok:true, transfer:object} | {ok:false, reason:string}}
 */
export function decodeTransferLog(log) {
  if (!log || typeof log !== "object") return { ok: false, reason: "LOG_NOT_OBJECT" };
  if (log.removed === true) return { ok: false, reason: "REORGED" };

  const topics = log.topics;
  if (!Array.isArray(topics) || topics.length !== 3) return { ok: false, reason: "NONSTANDARD_TOPICS" };
  if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) return { ok: false, reason: "NOT_A_TRANSFER" };

  const from = decodeAddressTopic(topics[1]);
  if (!from.ok) return { ok: false, reason: `FROM_${from.reason}` };
  const to = decodeAddressTopic(topics[2]);
  if (!to.ok) return { ok: false, reason: `TO_${to.reason}` };

  const amount = decodeSingleWord(log.data);
  if (!amount.ok) return { ok: false, reason: `AMOUNT_${amount.reason}` };

  if (!/^0x[0-9a-fA-F]{40}$/.test(String(log.address ?? ""))) {
    return { ok: false, reason: "BAD_TOKEN_ADDRESS" };
  }

  let blockNumber, logIndex;
  try {
    blockNumber = Number(decodeUint(log.blockNumber));
    logIndex = Number(decodeUint(log.logIndex));
  } catch {
    return { ok: false, reason: "BAD_POSITION" };
  }
  if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(logIndex)) {
    return { ok: false, reason: "BAD_POSITION" };
  }

  return {
    ok: true,
    transfer: {
      token: toChecksumAddress(log.address),
      from: toChecksumAddress(from.address),
      to: toChecksumAddress(to.address),
      kind: classifyKind(from.address, to.address),
      amountRaw: amount.amount,
      blockNumber,
      logIndex,
      txHash: String(log.transactionHash ?? ""),
    },
  };
}

/**
 * Build a concise explanation of what moved, how much, and where to (with known labels).
 */
export function describeMove({ kind, amount, symbol, sharePercent: pct, from, to, fromLabel, toLabel }) {
  const fmtParty = (addr, label) => (label ? `${addr} (${label})` : addr);
  if (kind === "MINT") {
    return `Minted ${amount} ${symbol} (${pct}% of supply) to ${fmtParty(to, toLabel)}`;
  }
  if (kind === "BURN") {
    return `Burned ${amount} ${symbol} (${pct}% of supply) from ${fmtParty(from, fromLabel)}`;
  }
  if (kind === "SELF") {
    return `Self-transferred ${amount} ${symbol} (${pct}% of supply) at ${fmtParty(from, fromLabel)}`;
  }
  return `Moved ${amount} ${symbol} (${pct}% of supply) from ${fmtParty(from, fromLabel)} to ${fmtParty(to, toLabel)}`;
}

/**
 * Attach token metadata and the share-of-supply metric.
 * Requires a token record already read from the chain; nothing here defaults.
 *
 * @param {object} transfer
 * @param {object} token
 * @param {Map<string, string>|Record<string, string>} [extraLabels]
 * @returns {object} finding
 */
export function toFinding(transfer, token, extraLabels = null) {
  const bps = shareBps(transfer.amountRaw, token.totalSupplyRaw);
  const amount = formatRawShort(transfer.amountRaw, token.decimals, 6);
  const pct = sharePercent(transfer.amountRaw, token.totalSupplyRaw);
  const tokenSelfLabel = `${token.symbol} Token Contract`;
  const resolveLabel = (addr) => {
    const known = labelAddress(addr, extraLabels);
    if (known) return known;
    if (addr.toLowerCase() === token.address.toLowerCase()) return tokenSelfLabel;
    return null;
  };
  const fromLabel = resolveLabel(transfer.from);
  const toLabel = resolveLabel(transfer.to);

  return {
    token: {
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      totalSupply: formatRaw(token.totalSupplyRaw, token.decimals),
    },
    kind: transfer.kind,
    from: transfer.from,
    fromLabel,
    to: transfer.to,
    toLabel,
    amountRaw: transfer.amountRaw.toString(),
    // Display value, truncated to 6 decimals — never rounded up. The exact
    // integer is amountRaw and the exact decimal is amountExact.
    amount,
    amountExact: formatRaw(transfer.amountRaw, token.decimals),
    // Kept as a decimal string, not a BigInt: this object is serialised straight
    // into the API response, and JSON.stringify throws on BigInt. Ranking parses
    // it back. Everything else here is already a string for the same reason.
    shareBpsRaw: bps.toString(),
    shareBps: Number(bps),
    sharePercent: pct,
    explanation: describeMove({
      kind: transfer.kind,
      amount,
      symbol: token.symbol,
      sharePercent: pct,
      from: transfer.from,
      to: transfer.to,
      fromLabel,
      toLabel,
    }),
    blockNumber: transfer.blockNumber,
    logIndex: transfer.logIndex,
    txHash: transfer.txHash,
  };
}
