// Exact decimal arithmetic for money.
//
// Nothing in this file converts an amount through a JS number. A double has 53
// bits of mantissa; 1 PROS is 1e18 wei, so any amount above ~9 PROS loses
// precision the moment it becomes a float. The original scaffold did exactly
// that and encoded 8.13 PROS as 8130000000000001024 wei — 1024 wei too much,
// silently, with no error and no way for the caller to notice.
//
// So: strings in, BigInt out, and a hard refusal whenever the requested amount
// cannot be represented exactly. Refusing is the whole point. A payment tool
// that rounds is a payment tool that mispays.

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Parse a human decimal string into integer base units.
 *
 * @param {string} text        e.g. "8.13"
 * @param {number} decimals    token decimals, e.g. 18
 * @returns {{ok: true, raw: bigint} | {ok: false, error: string}}
 */
export function parseDecimal(text, decimals) {
  if (typeof text !== "string") return { ok: false, error: "amount must be a string" };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return { ok: false, error: `unsupported token decimals: ${decimals}` };
  }

  const s = text.trim();
  if (s === "") return { ok: false, error: "amount is empty" };

  // Reject anything that is not plain positional decimal notation. Underscores,
  // thousands separators, exponents and signs are all refused rather than
  // guessed at: "1,5" means 1.5 in one locale and 15 in another, and a payment
  // agent does not get to pick.
  if (/[,_\s]/.test(s)) {
    return { ok: false, error: `amount must not contain separators: "${text}"` };
  }
  if (/^[+-]/.test(s)) {
    return { ok: false, error: `amount must be positive: "${text}"` };
  }
  if (/[eE]/.test(s)) {
    return { ok: false, error: `amount must not use exponent notation: "${text}"` };
  }

  const m = DECIMAL.exec(s);
  if (!m) {
    return { ok: false, error: `amount is not a decimal number: "${text}"` };
  }

  const frac = m[1] ?? "";
  if (frac.length > decimals) {
    // Not truncated, not rounded. The extra digits are real value, and dropping
    // them would make the transaction pay a different amount than the user said.
    return {
      ok: false,
      error:
        `amount "${text}" has ${frac.length} decimal places but this token ` +
        `supports ${decimals}; it cannot be represented exactly`,
    };
  }

  const whole = s.split(".")[0];
  const scaled = whole + frac.padEnd(decimals, "0");
  return { ok: true, raw: BigInt(scaled === "" ? "0" : scaled) };
}

/**
 * Render integer base units back to an exact decimal string.
 * Trailing fractional zeros are dropped, but a whole token stays "1", not "1.".
 */
/**
 * Same as formatRaw, but the fractional part is truncated (never rounded) to at
 * most `maxFractionDigits`. Truncation can only make the displayed number
 * smaller than the real one, so a displayed amount is never an overstatement.
 * The exact value stays available as `amountRaw`.
 *
 * @param {bigint|string} raw
 * @param {number} decimals
 * @param {number} maxFractionDigits
 * @returns {string}
 */
export function formatRawShort(raw, decimals, maxFractionDigits = 6) {
  const full = formatRaw(raw, decimals);
  const dot = full.indexOf(".");
  if (dot === -1) return full;
  const cut = full.slice(0, dot + 1 + maxFractionDigits).replace(/\.$/, "");
  return cut;
}

export function formatRaw(raw, decimals) {
  const v = typeof raw === "bigint" ? raw : BigInt(String(raw));
  const negative = v < 0n;
  const abs = negative ? -v : v;

  if (decimals === 0) return (negative ? "-" : "") + abs.toString();

  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = abs / base;
  const frac = abs % base;

  let out = whole.toString();
  if (frac > 0n) {
    const padded = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    out += "." + padded;
  }
  return (negative ? "-" : "") + out;
}

/** 1234567 -> "1,234,567". Presentation only; never fed back into arithmetic. */
export function groupDigits(value) {
  const s = String(value);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
