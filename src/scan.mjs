// One scan: chain check, window sizing, chunked read, ranking, watchlist.
//
// The caller supplies intent — how far back, how big counts as a whale — and
// nothing else. It cannot supply transfers, amounts, balances or a verdict. That
// asymmetry is the point: the scaffold's `inspectTransferForWhaleMove` took
// `from`, `to`, `amountWei` and even `watchedAddresses` from the request body, so
// the caller decided who the whales were and what counted as large, and the
// "agent" only did arithmetic on the caller's own claim.

import { createRpc, RpcError, decodeQuantity } from "./rpc.mjs";
import { scanRange } from "./logs.mjs";
import { createTokenCache, TRANSFER_TOPIC } from "./tokens.mjs";
import { decodeTransferLog, toFinding } from "./whales.mjs";
import { rankFindings, shareBps } from "./share.mjs";
import { normalizeAddress, DEFAULT_WATCHLIST, labelAddress } from "./address.mjs";
import { scanNative, buildNativeFinding, NATIVE_SYMBOL, NATIVE_DECIMALS, NATIVE_MAX_BLOCKS } from "./native.mjs";
import { formatRaw, parseDecimal } from "./numbers.mjs";

export const PHAROS_CHAIN_ID = 1672n;
export const DEFAULT_HEAD_URL = "https://rpc.pharos.xyz";

export const LIMITS = {
  maxHours: 6,
  maxChunks: 6, // bounds a scan to 6000 blocks, whatever the block time is
  maxLimit: 100,
  maxWatch: 20,
};

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

const hex = (n) => "0x" + n.toString(16);

/**
 * Measure block time from the chain instead of assuming it. Window sizing in
 * hours depends on this number, and a wrong value silently scans the wrong span.
 */
async function measureBlockTime(rpc, head) {
  const probe = Math.min(1000, Math.max(1, head));
  const [newer, older] = await Promise.all([
    rpc.call("eth_getBlockByNumber", [hex(head), false]),
    rpc.call("eth_getBlockByNumber", [hex(head - probe), false]),
  ]);
  if (!newer || !older) throw new Error("block not available for timing probe");
  const dt = Number(decodeQuantity(newer.timestamp) - decodeQuantity(older.timestamp));
  if (!(dt > 0)) throw new Error(`non-positive time delta across ${probe} blocks`);
  return dt / probe;
}

/**
 * @param {object} options
 * @param {number} [options.hours]
 * @param {number} [options.minShareBps]
 * @param {number} [options.limit]
 * @param {string[]} [options.watch]
 * @param {string} [options.rpcUrl]
 * @param {object} [options.rpc]  injected for tests
 */
export async function scan({
  hours = 1,
  minShareBps = 1,
  limit = 20,
  watch = DEFAULT_WATCHLIST,
  minPros = "0",
  rpcUrl = DEFAULT_HEAD_URL,
  rpc,
} = {}) {
  const started = Date.now();

  if (!Number.isFinite(hours) || hours <= 0 || hours > LIMITS.maxHours) {
    return fail("BAD_HOURS", `hours must be > 0 and <= ${LIMITS.maxHours}, got ${hours}`);
  }
  if (!Number.isInteger(minShareBps) || minShareBps < 0 || minShareBps > 10000) {
    return fail("BAD_THRESHOLD", `minShareBps must be an integer 0..10000, got ${minShareBps}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxLimit) {
    return fail("BAD_LIMIT", `limit must be an integer 1..${LIMITS.maxLimit}, got ${limit}`);
  }
  if (!Array.isArray(watch) || watch.length > LIMITS.maxWatch) {
    return fail("BAD_WATCH", `watch must be an array of at most ${LIMITS.maxWatch} addresses`);
  }
  if (typeof minPros !== "string") {
    return fail("BAD_MIN_PROS", "minPros must be a decimal string of native PROS");
  }
  const minProsParsed = parseDecimal(minPros, NATIVE_DECIMALS);
  if (!minProsParsed.ok) {
    return fail("BAD_MIN_PROS", `minPros ${minProsParsed.error}`);
  }
  const minProsWei = minProsParsed.raw;

  // Watchlist entries are the only addresses accepted from a human. They are
  // checksum-verified, because a typo here is indistinguishable from silence.
  const watched = [];
  for (const entry of watch) {
    const parsed = normalizeAddress(entry);
    if (!parsed.ok) return fail("BAD_WATCH_ADDRESS", parsed.error);
    watched.push(parsed.address);
  }
  const watchedLower = new Set(watched.map((a) => a.toLowerCase()));

  const client = rpc ?? createRpc({ url: rpcUrl });

  // Any object with a `call` method works here, which is what lets the whole
  // scan run offline against a fake chain in the tests.
  let chainId, head;
  try {
    chainId = decodeQuantity(await client.call("eth_chainId", []));
  } catch (e) {
    return fail("RPC_UNAVAILABLE", `could not read chain id: ${e.message}`);
  }
  if (chainId !== PHAROS_CHAIN_ID) {
    return fail("WRONG_CHAIN", `expected chain ${PHAROS_CHAIN_ID}, endpoint reports ${chainId}`);
  }

  try {
    head = Number(decodeQuantity(await client.call("eth_blockNumber", [])));
  } catch (e) {
    return fail("RPC_UNAVAILABLE", `could not read head block: ${e.message}`);
  }

  let blockTime;
  try {
    blockTime = await measureBlockTime(client, head);
  } catch (e) {
    return fail("BLOCK_TIME_UNAVAILABLE", `could not measure block time: ${e.message}`);
  }

  const requestedBlocks = Math.max(1, Math.round((hours * 3600) / blockTime));
  const capBlocks = LIMITS.maxChunks * 1000;
  const capped = Math.min(requestedBlocks, capBlocks);
  const fromBlock = Math.max(0, head - capped + 1);
  // The chain is finite: asking for a window wider than the chain gives a
  // shorter one, and that has to be visible rather than assumed away.
  const windowBlocks = head - fromBlock + 1;

  let range;
  try {
    range = await scanRange(client, {
      fromBlock,
      toBlock: head,
      topics: [TRANSFER_TOPIC],
    });
  } catch (e) {
    if (e instanceof RpcError) return fail("RPC_UNAVAILABLE", `log scan failed: ${e.message}`);
    throw e;
  }

  // Fail closed. No chunk read means the chain told us nothing, and an empty
  // findings list would otherwise be indistinguishable from a quiet market.
  if (range.chunksRead === 0) {
    return fail("SCAN_UNAVAILABLE", "no chunk could be read; this is not an empty result", {
      scan: { failedChunks: range.failedChunks, chunksPlanned: range.chunksPlanned },
    });
  }

  const skipped = new Map();
  const bump = (reason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const transfers = [];
  for (const log of range.logs) {
    const decoded = decodeTransferLog(log);
    if (!decoded.ok) {
      bump(decoded.reason);
      continue;
    }
    transfers.push(decoded.transfer);
  }

  const tokens = createTokenCache(client);
  const dynamicLabels = new Map();
  for (const address of new Set(transfers.map((t) => t.token.toLowerCase()))) {
    const meta = await tokens.get(address);
    if (!meta.ok) bump(meta.reason.split(":")[0]);
    else dynamicLabels.set(address, `${meta.token.symbol} Token Contract`);
  }
  watched.forEach((addr, idx) => {
    const k = addr.toLowerCase();
    if (!labelAddress(addr, dynamicLabels)) {
      dynamicLabels.set(k, `Watched #${idx + 1}`);
    }
  });

  const findings = [];
  const watchedActivity = [];
  const watchStats = new Map(
    watched.map((addr) => [
      addr.toLowerCase(),
      {
        address: addr,
        label: labelAddress(addr, dynamicLabels),
        inCount: 0,
        outCount: 0,
        totalTouches: 0,
        significantTouches: 0,
        maxShareBps: 0,
        tokensMoved: new Set(),
        nativeIn: 0,
        nativeOut: 0,
      },
    ]),
  );
  let unreadableTokenTransfers = 0;
  let metadataUnavailable = 0;
  let metadataInvalid = 0;

  for (const transfer of transfers) {
    const meta = await tokens.get(transfer.token.toLowerCase());
    if (!meta.ok) {
      unreadableTokenTransfers++;
      if (meta.transient) metadataUnavailable++;
      else metadataInvalid++;
      continue;
    }
    const fromLow = transfer.from.toLowerCase();
    const toLow = transfer.to.toLowerCase();
    const touchesWatch = watchedLower.has(fromLow) || watchedLower.has(toLow);
    // Compute the cheap share first and build the full finding only when the
    // transfer will be shown. toFinding performs checksum + explanation work
    // that would otherwise run for every log and blow the Workers CPU budget.
    const isSignificant = shareBps(transfer.amountRaw, meta.token.totalSupplyRaw) >= BigInt(minShareBps);
    if (!isSignificant && !touchesWatch) continue;
    const finding = toFinding(transfer, meta.token, dynamicLabels);

    if (touchesWatch) {
      const direction = watchedLower.has(fromLow) && watchedLower.has(toLow)
        ? "SELF"
        : watchedLower.has(fromLow)
        ? "OUT"
        : "IN";
      watchedActivity.push({ ...finding, direction });

      if (watchStats.has(fromLow)) {
        const st = watchStats.get(fromLow);
        st.outCount++;
        st.totalTouches++;
        if (isSignificant) st.significantTouches++;
        if (finding.shareBps > st.maxShareBps) st.maxShareBps = finding.shareBps;
        st.tokensMoved.add(meta.token.symbol);
      }
      if (toLow !== fromLow && watchStats.has(toLow)) {
        const st = watchStats.get(toLow);
        st.inCount++;
        st.totalTouches++;
        if (isSignificant) st.significantTouches++;
        if (finding.shareBps > st.maxShareBps) st.maxShareBps = finding.shareBps;
        st.tokensMoved.add(meta.token.symbol);
      }
    }
    if (isSignificant) findings.push(finding);
  }

  // Every token was unreadable for an availability reason: the scan looked and
  // saw nothing, but not because nothing happened. Ranking over an empty set
  // here would be a report about the endpoint's mood, not about the chain.
  const tokensSeenCount = tokens.size;
  if (unreadableTokenTransfers > 0 && metadataInvalid === 0 && metadataUnavailable > 0) {
    const all = [...tokens.entries()].every(([, r]) => !r.ok && r.transient);
    if (all) {
      return fail(
        "METADATA_UNAVAILABLE",
        `none of the ${tokensSeenCount} token contract(s) in this window could be read; ` +
          `the transfers were seen but none can be ranked against a total supply`,
        {
          scan: {
            chunksRead: range.chunksRead,
            chunksPlanned: range.chunksPlanned,
            transfersRead: range.logs.length,
            tokensSeen: tokensSeenCount,
            metadataUnavailable,
          },
        },
      );
    }
  }

  const ranked = rankFindings(findings).slice(0, limit);
  const rankedWatchActivity = rankFindings(watchedActivity).slice(0, limit);

  // Native PROS has no Transfer log; movement lives in each block's transaction
  // bodies. Read those in a bounded window and fold them into the same report.
  // Native is additive and fail-soft: a native read that cannot complete must not
  // invalidate the ERC-20 findings, because those are already a complete answer
  // about the token ledger.
  let native = null;
  let nativeFindings = [];
  const nativeBalances = new Map(); // lower -> {start: bigint|null, head: bigint|null}
  if (watched.length > 0 && typeof client.batch === "function") {
    const nativeFromBlock = Math.max(fromBlock, head - NATIVE_MAX_BLOCKS + 1);
    // Balance delta covers the full requested window, not just the bounded block
    // body scan, so the summary's PROS Δ is the honest change over `hours` even
    // when individual transfers are only read from the most recent blocks.
    const startBlock = Math.max(0, fromBlock - 1);

    const resolveNativeLabel = (addr) => labelAddress(addr, dynamicLabels) ?? null;

    for (const addr of watched) {
      const key = addr.toLowerCase();
      let startBal = null;
      let headBal = null;
      try {
        startBal = decodeQuantity(await client.call("eth_getBalance", [addr, hex(startBlock)]));
      } catch {
        // A missing balance is a gap, not a reason to drop the watch summary.
      }
      try {
        headBal = decodeQuantity(await client.call("eth_getBalance", [addr, hex(head)]));
      } catch {
        // As above.
      }
      nativeBalances.set(key, { start: startBal, head: headBal });
    }

    let nativeScanResult;
    try {
      nativeScanResult = await scanNative(client, {
        fromBlock: nativeFromBlock,
        toBlock: head,
        watched,
      });
    } catch (e) {
      nativeScanResult = {
        transfers: [],
        fromBlock: nativeFromBlock,
        toBlock: head,
        blocksPlanned: head - nativeFromBlock + 1,
        blocksRead: 0,
        failedChunks: [{ fromBlock: nativeFromBlock, toBlock: head, error: e.message }],
        partial: true,
      };
    }

    const nativeTransfers = [];
    for (const nt of nativeScanResult.transfers) {
      if (nt.valueRaw < minProsWei) continue;
      const finding = buildNativeFinding(nt, resolveNativeLabel);
      nativeTransfers.push(finding);

      if (nt.direction === "NATIVE_OUT" || nt.direction === "NATIVE_SELF") {
        const st = watchStats.get(nt.from);
        if (st) st.nativeOut++;
      }
      if (nt.to != null && (nt.direction === "NATIVE_IN" || nt.direction === "NATIVE_SELF")) {
        const st = watchStats.get(nt.to);
        if (st) st.nativeIn++;
      }
    }
    nativeFindings = nativeTransfers.sort(
      (a, b) => b.blockNumber - a.blockNumber || b.txIndex - a.txIndex,
    );

    native = {
      fromBlock: nativeScanResult.fromBlock,
      toBlock: nativeScanResult.toBlock,
      blocksPlanned: nativeScanResult.blocksPlanned,
      blocksRead: nativeScanResult.blocksRead,
      transfersRead: nativeScanResult.transfers.length,
      transfersReported: nativeFindings.length,
      failedChunkCount: nativeScanResult.failedChunks.length,
      failedChunks: nativeScanResult.failedChunks.slice(0, 10),
      partial: nativeScanResult.partial,
      truncated: nativeFromBlock > fromBlock,
    };
  }

  const watchSummary = [...watchStats.values()].map((st) => {
    const bal = nativeBalances.get(st.address.toLowerCase());
    const nativeBalanceWei = bal?.head != null ? bal.head.toString() : null;
    const nativeBalance = bal?.head != null ? formatRaw(bal.head, NATIVE_DECIMALS) : null;
    let nativeDeltaWei = null;
    let nativeDelta = null;
    if (bal?.head != null && bal?.start != null) {
      const delta = bal.head - bal.start;
      nativeDeltaWei = delta.toString();
      const fmt = formatRaw(delta, NATIVE_DECIMALS);
      nativeDelta = delta > 0n ? "+" + fmt : fmt;
    }
    const nativeActive =
      st.nativeIn > 0 || st.nativeOut > 0 || (nativeDeltaWei !== null && nativeDeltaWei !== "0");
    return {
      address: st.address,
      label: st.label,
      inCount: st.inCount,
      outCount: st.outCount,
      totalTouches: st.totalTouches,
      significantTouches: st.significantTouches,
      maxShareBps: st.maxShareBps,
      tokens: [...st.tokensMoved],
      nativeIn: st.nativeIn,
      nativeOut: st.nativeOut,
      nativeBalanceWei,
      nativeBalance,
      nativeDeltaWei,
      nativeDelta,
      status: st.totalTouches > 0 || nativeActive ? "ACTIVE" : "QUIET",
    };
  });

  // Token counts, for the response header. Read from the cache, not assumed.
  const tokensSeen = tokensSeenCount;

  return {
    ok: true,
    scan: {
      chainId: Number(chainId),
      headBlock: head,
      fromBlock,
      toBlock: head,
      blocksRequested: requestedBlocks,
      blocksCap: capBlocks,
      windowBlocks,
      blocksScanned: range.blocksRead,
      // blocksCapped alone never said how much of the window survived. These
      // three do: what was asked for, what the caps allowed, what was read.
      blocksCapped: requestedBlocks > capped,
      capTruncatedBlocks: requestedBlocks > capped ? requestedBlocks - capped : 0,
      windowCoverageBps: windowBlocks > 0 ? Math.floor((range.blocksRead * 10000) / windowBlocks) : 0,
      windowSecondsCovered: Math.round((range.blocksRead * blockTime) * 100) / 100,
      windowSecondsRequested: Math.round(hours * 3600),
      blockTimeSeconds: Number(blockTime.toFixed(4)),
      chunksPlanned: range.chunksPlanned,
      chunksRead: range.chunksRead,
      failedChunks: range.failedChunks.slice(0, 10),
      failedChunkCount: range.failedChunks.length,
      partial: range.partial,
      transfersRead: range.logs.length,
      transfersDecoded: transfers.length,
      transfersRanked: transfers.length - unreadableTokenTransfers,
      transfersUnranked: unreadableTokenTransfers,
      metadataUnavailable,
      metadataInvalid,
      // partial means chunks failed; degraded means some transfers were seen but
      // could not be measured, so the ranking is over a subset of what moved.
      degraded: range.partial || unreadableTokenTransfers > 0,
      tokensSeen,
      native,
      // The row limit cuts the list, not the market. Say how many were matched.
      findingsMatched: findings.length,
      findingsReturned: ranked.length,
      findingsTruncated: Math.max(0, findings.length - ranked.length),
      durationMs: Date.now() - started,
    },
    threshold: { minShareBps, minPros },
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    findings: ranked,
    watch: {
      addresses: watched,
      summary: watchSummary,
      activity: rankedWatchActivity,
      native: nativeFindings,
    },
  };
}
