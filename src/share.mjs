// Ranking transfers across tokens that share nothing.
//
// The scaffold compared every transfer to one threshold in wei (`1000e18`).
// On this chain that threshold means 1000 WPROS, 1,000,000,000,000 USDC, and
// 100,000,000,000 BTCVP, because decimals differ per token. A single wei number
// is not a threshold, it is a threshold for exactly one token.
//
// Price-free normalisation that works for any token: the fraction of total
// supply moved. `500000000000` USDC (6dp) and `500000000000000000000` WPROS
// (18dp) are the same share of their supply, and can be ranked against each
// other without knowing what either is worth.
//
// Integer division floors, so a share is never overstated. Nothing here touches
// a JS number: a double cannot hold a uint256, and shares are computed on
// amounts that routinely exceed 2^53.

/**
 * Share of total supply in basis points (1 bps = 0.01%), floored.
 *
 * @param {bigint} amount  raw units moved
 * @param {bigint} supply  raw total supply
 * @returns {bigint}
 */
export function shareBps(amount, supply) {
  if (typeof amount !== "bigint" || typeof supply !== "bigint") {
    throw new TypeError("shareBps requires BigInt arguments");
  }
  if (amount < 0n) throw new RangeError("amount must not be negative");
  if (supply <= 0n) throw new RangeError("totalSupply must be positive to rank a transfer");
  return (amount * 10000n) / supply;
}

/**
 * Exact percentage string with up to 4 decimals, floored, trailing zeros trimmed.
 * `4.01` and `0.0001` come out of integer arithmetic, not `toFixed`.
 *
 * A share too small to show at 4 decimals is reported as "<0.0001" rather than
 * "0". Printing zero for a non-zero transfer would say nothing moved, which is
 * the opposite of what happened.
 *
 * @returns {string}
 */
export function sharePercent(amount, supply) {
  if (supply <= 0n) throw new RangeError("totalSupply must be positive to rank a transfer");
  if (amount === 0n) return "0";
  const micro = (amount * 1_000_000n) / supply; // percent x 10^4
  if (micro === 0n) return amount > 0n ? "<0.0001" : "0";
  const whole = micro / 10000n;
  const frac = micro % 10000n;
  if (frac === 0n) return whole.toString();
  const padded = frac.toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}.${padded}`;
}

/**
 * Sort key: larger share first, then more recent block, then higher log index.
 * Returns a new array; ties are fully broken so output is deterministic.
 */
export function rankFindings(findings) {
  return [...findings].sort((a, b) => {
    const ab = BigInt(a.shareBpsRaw);
    const bb = BigInt(b.shareBpsRaw);
    if (ab !== bb) return ab > bb ? -1 : 1;
    if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
    if (a.logIndex !== b.logIndex) return b.logIndex - a.logIndex;
    return a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0;
  });
}
