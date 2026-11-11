import { suite, test, assert, eq, throws, report, fakeChain, transferLog, encodeString, encodeBytes32, TRANSFER_TOPIC } from "./harness.mjs";

import { isHex, decodeUint, decodeSingleWord, decodeAddressTopic, toWord } from "../src/hex.mjs";
import { toChecksumAddress, normalizeAddress, isZeroAddress, DEFAULT_WATCHLIST, labelAddress } from "../src/address.mjs";
import { shareBps, sharePercent, rankFindings } from "../src/share.mjs";
import { formatRaw, formatRawShort, parseDecimal } from "../src/numbers.mjs";
import { decodeSymbol, readToken, createTokenCache } from "../src/tokens.mjs";
import { planChunks, scanRange, MAX_BLOCK_SPAN } from "../src/logs.mjs";
import { decodeTransferLog, classifyKind, toFinding } from "../src/whales.mjs";
import { scan, LIMITS } from "../src/scan.mjs";
import { keccak256Hex } from "../src/keccak.mjs";

const WPROS = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const WHALE = toChecksumAddress("0x7a16ff8270133f063aab6c9977183d9e72835428");
const POOL = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";
const ALICE = "0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2";

const tokens = {
  [WPROS]: { symbol: "WPROS", decimals: 18, totalSupply: 10n ** 24n },
  [USDC]: { symbol: "USDC", decimals: 6, totalSupply: 10n ** 12n },
};

suite("keccak and topics");

await test("keccak256 matches the known Transfer topic", () => {
  // The single most load-bearing constant in this tool. If keccak is wrong
  // (SHA3 padding instead of Keccak), every log is filtered out and the tool
  // reports a quiet chain forever.
  eq(keccak256Hex("Transfer(address,address,uint256)"), TRANSFER_TOPIC);
});

await test("keccak256 distinguishes Keccak from SHA3 padding", () => {
  // SHA3-256("") is a3f2..., Keccak-256("") is c5d2...
  eq(keccak256Hex("").slice(0, 10), "0xc5d24601");
});

suite("hex decoding");

await test("decodeUint parses hex quantities", () => {
  eq(decodeUint("0x0"), 0n);
  eq(decodeUint("0x16e360"), 1500000n);
});

await test("an empty quantity is an error, not zero", () => {
  // "0x" is how some endpoints report a missing value. Reading it as zero would
  // turn "unknown" into "empty block" and hide a broken read.
  throws(() => decodeUint("0x"));
});

await test("decodeUint refuses non-hex", () => {
  throws(() => decodeUint("1234"));
  throws(() => decodeUint(null));
  throws(() => decodeUint("0xzz"));
});

await test("decodeSingleWord accepts exactly one word", () => {
  const one = decodeSingleWord("0x" + "0".repeat(63) + "5");
  assert(one.ok);
  eq(one.amount, 5n);
});

await test("decodeSingleWord refuses a transfer with trailing data", () => {
  // A token that appends data is not ERC-20 Transfer. Taking the first word
  // would report half a number as if it were the amount.
  const two = decodeSingleWord("0x" + "0".repeat(63) + "5" + "0".repeat(64));
  assert(!two.ok);
  eq(two.reason, "DATA_NOT_ONE_WORD");
});

await test("decodeSingleWord refuses an empty payload", () => {
  const empty = decodeSingleWord("0x");
  assert(!empty.ok);
  eq(empty.reason, "DATA_NOT_ONE_WORD");
});

await test("decodeAddressTopic rejects dirty padding", () => {
  // Masking the top bytes would turn an unrelated 32-byte value into an address.
  const dirty = decodeAddressTopic("0x" + "f".repeat(24) + "1".repeat(40));
  assert(!dirty.ok);
  eq(dirty.reason, "TOPIC_DIRTY_PADDING");
});

await test("decodeAddressTopic extracts a clean address", () => {
  const ok = decodeAddressTopic("0x" + "0".repeat(24) + WHALE.slice(2).toLowerCase());
  assert(ok.ok);
  eq(ok.address, WHALE.toLowerCase());
});

await test("toWord left-pads to 32 bytes", () => {
  eq(toWord(1n), "0".repeat(63) + "1");
  eq(toWord(10n ** 18n).length, 64);
});

suite("addresses");

await test("checksum matches EIP-55 test vectors", () => {
  eq(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  eq(toChecksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"), "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
});

await test("mixed-case with a wrong character is refused, not repaired", () => {
  const r = normalizeAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD");
  assert(!r.ok);
  assert(r.error.includes("checksum"));
});

await test("all-lowercase input is accepted and case-normalised", () => {
  const r = normalizeAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  assert(r.ok);
  eq(r.address, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
});

await test("wrong length is named, not truncated", () => {
  const r = normalizeAddress("0x1234");
  assert(!r.ok);
  assert(r.error.includes("42 characters"));
});

await test("zero address is recognised", () => {
  assert(isZeroAddress("0x0000000000000000000000000000000000000000"));
  assert(!isZeroAddress(WHALE));
});

await test("default watchlist contains at least 5 checksummed Pharos addresses", () => {
  assert(DEFAULT_WATCHLIST.length >= 5);
  for (const addr of DEFAULT_WATCHLIST) {
    const r = normalizeAddress(addr);
    assert(r.ok && r.address === addr, `invalid default watch address ${addr}`);
  }
  eq(labelAddress("0x0000000000000000000000000000000000000000"), "Zero Address");
});

suite("share of supply");

await test("shareBps floors instead of rounding up", () => {
  eq(shareBps(1n, 3n), 3333n);
  eq(shareBps(1n, 10000n), 1n);
  eq(shareBps(1n, 100000n), 0n);
});

await test("shareBps refuses a zero supply", () => {
  throws(() => shareBps(1n, 0n));
});

await test("sharePercent is exact for equal shares across different decimals", () => {
  // 1e21 of an 18-decimal supply of 1e24, and 1e9 of a 6-decimal supply of 1e12,
  // are the same 0.1% — the case a single wei threshold cannot express.
  eq(sharePercent(10n ** 21n, 10n ** 24n), "0.1");
  eq(sharePercent(10n ** 9n, 10n ** 12n), "0.1");
});

await test("a share too small to display says so instead of printing zero", () => {
  // Printing "0%" for a real transfer would claim nothing moved.
  eq(sharePercent(1n, 10n ** 24n), "<0.0001");
  eq(sharePercent(1n, 3n), "33.3333");
  eq(sharePercent(0n, 10n ** 24n), "0");
});

await test("rankFindings breaks ties deterministically", () => {
  const rows = [
    { shareBpsRaw: "5", blockNumber: 10, logIndex: 0, txHash: "0xaa" },
    { shareBpsRaw: "5", blockNumber: 12, logIndex: 0, txHash: "0xbb" },
    { shareBpsRaw: "9", blockNumber: 1, logIndex: 0, txHash: "0xcc" },
  ];
  const ranked = rankFindings(rows);
  eq(ranked[0].txHash, "0xcc");
  eq(ranked[1].txHash, "0xbb");
  eq(ranked[2].txHash, "0xaa");
});

suite("exact numbers");

await test("the display amount is truncated, never rounded up", () => {
  // 0.528479988729089059 PROS must not display as 0.528480, because that is a
  // larger number than the transfer. Truncation can only understate.
  eq(formatRawShort(528479988729089059n, 18, 6), "0.528479");
  eq(formatRawShort(10n ** 21n, 18, 6), "1000");
  eq(formatRawShort(999999n, 6, 6), "0.999999");
});

await test("formatRaw respects per-token decimals", () => {
  eq(formatRaw(10n ** 9n, 6), "1000");
  eq(formatRaw(10n ** 21n, 18), "1000");
  eq(formatRaw(1n, 6), "0.000001");
  eq(formatRaw(0n, 18), "0");
});

await test("parseDecimal rejects locale separators rather than guessing", () => {
  const r = parseDecimal("1,5", 18);
  assert(!r.ok);
  assert(r.error.includes("separators"));
});

suite("token metadata");

await test("decodeSymbol handles the ABI string form", () => {
  eq(decodeSymbol(encodeString("WPROS")), "WPROS");
  eq(decodeSymbol(encodeString("stPROS")), "stPROS");
});

await test("decodeSymbol handles bytes32 tokens", () => {
  eq(decodeSymbol(encodeBytes32("MKR")), "MKR");
});

await test("decodeSymbol refuses empty and garbage", () => {
  eq(decodeSymbol("0x"), null);
  eq(decodeSymbol("0x00"), null);
});

await test("readToken reads decimals and supply from the chain", async () => {
  const chain = fakeChain({ tokens });
  const r = await readToken(chain, WPROS);
  assert(r.ok, r.reason);
  eq(r.token.symbol, "WPROS");
  eq(r.token.decimals, 18);
  eq(r.token.totalSupplyRaw, 10n ** 24n);
});

await test("readToken keeps 6-decimal tokens at 6", async () => {
  const chain = fakeChain({ tokens });
  const r = await readToken(chain, USDC);
  assert(r.ok);
  eq(r.token.decimals, 6);
});

await test("readToken refuses a contract that does not answer", async () => {
  const chain = fakeChain({ tokens });
  const r = await readToken(chain, "0x9999999999999999999999999999999999999999");
  assert(!r.ok);
  eq(r.reason, "DECIMALS_UNREADABLE");
});

await test("readToken refuses a zero supply instead of dividing by it", async () => {
  const chain = fakeChain({ tokens: { [WPROS]: { symbol: "Z", decimals: 18, totalSupply: 0n } } });
  const r = await readToken(chain, WPROS);
  assert(!r.ok);
  eq(r.reason, "TOTAL_SUPPLY_ZERO");
});

await test("token cache reads each token once", async () => {
  const chain = fakeChain({ tokens });
  const cache = createTokenCache(chain);
  await Promise.all([cache.get(WPROS), cache.get(WPROS), cache.get(WPROS)]);
  const calls = chain.calls.filter((c) => c.method === "eth_call");
  eq(calls.length, 3, "three metadata calls for one token, not nine");
});

suite("log chunking");

await test("a 1000-block range is one chunk", () => {
  eq(planChunks(0, 999).length, 1);
  eq(MAX_BLOCK_SPAN, 1000);
});

await test("a wider range splits into covered chunks", () => {
  const chunks = planChunks(100, 3099);
  eq(chunks.length, 3);
  eq(chunks[0].fromBlock, 100);
  eq(chunks[0].toBlock, 1099);
  eq(chunks[2].toBlock, 3099);
});

await test("planChunks refuses an inverted range and an oversized span", () => {
  throws(() => planChunks(10, 9));
  throws(() => planChunks(0, 10, 1001));
});

await test("scanRange counts read blocks and flags failures", async () => {
  const chain = fakeChain({ head: 5000, tokens, failFrom: new Set([4000]) });
  const r = await scanRange(chain, { fromBlock: 4000, toBlock: 5999, topics: [TRANSFER_TOPIC] });
  eq(r.chunksPlanned, 2);
  eq(r.chunksRead, 1);
  eq(r.blocksRead, 1000);
  assert(r.partial);
});

suite("transfer decoding");

await test("a Transfer log decodes into from, to and amount", () => {
  const log = transferLog({ token: WPROS, from: POOL, to: WHALE, amount: 10n ** 21n, block: 4500 });
  const d = decodeTransferLog(log);
  assert(d.ok, d.reason);
  eq(d.transfer.amountRaw, 10n ** 21n);
  eq(d.transfer.token, toChecksumAddress(WPROS));
  eq(d.transfer.kind, "TRANSFER");
});

await test("mints and burns are labelled, not dropped", () => {
  const zero = "0x0000000000000000000000000000000000000000";
  eq(classifyKind(zero, WHALE), "MINT");
  eq(classifyKind(WHALE, zero), "BURN");
  eq(classifyKind(WHALE, WHALE), "SELF");
  eq(classifyKind(POOL, WHALE), "TRANSFER");
});

await test("a reorged log is dropped", () => {
  const log = transferLog({ token: WPROS, from: POOL, to: WHALE, amount: 1n, block: 4500 });
  log.removed = true;
  const d = decodeTransferLog(log);
  assert(!d.ok);
  eq(d.reason, "REORGED");
});

await test("a log with four topics is refused", () => {
  const log = transferLog({ token: WPROS, from: POOL, to: WHALE, amount: 1n, block: 4500 });
  log.topics.push("0x" + "0".repeat(64));
  const d = decodeTransferLog(log);
  assert(!d.ok);
  eq(d.reason, "NONSTANDARD_TOPICS");
});

await test("toFinding formats with the token's own decimals", () => {
  const transfer = {
    token: toChecksumAddress(USDC),
    from: toChecksumAddress(POOL),
    to: toChecksumAddress(WHALE),
    kind: "TRANSFER",
    amountRaw: 10n ** 9n,
    blockNumber: 4500,
    logIndex: 0,
    txHash: "0xaa",
  };
  const f = toFinding(transfer, { address: toChecksumAddress(USDC), symbol: "USDC", decimals: 6, totalSupplyRaw: 10n ** 12n });
  eq(f.amount, "1000");
  eq(f.sharePercent, "0.1");
  eq(f.shareBps, 10);
});

suite("scan");

const scanSpec = {
  head: 5000,
  blockTime: 6,
  tokens,
  logs: [
    transferLog({ token: WPROS, from: POOL, to: WHALE, amount: 10n ** 21n, block: 4500, logIndex: 0 }),
    transferLog({ token: USDC, from: POOL, to: ALICE, amount: 10n ** 9n, block: 4600, logIndex: 1 }),
    transferLog({ token: WPROS, from: ALICE, to: POOL, amount: 10n ** 20n, block: 4700, logIndex: 2 }),
    transferLog({ token: WPROS, from: POOL, to: ALICE, amount: 10n ** 17n, block: 4800, logIndex: 3 }),
  ],
};

await test("scan finds and ranks real transfers by share", async () => {
  const chain = fakeChain(scanSpec);
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1, limit: 20 });
  assert(r.ok, r.error);
  eq(r.findings.length, 3, "the 1e17 transfer is below 1 bps");
  eq(r.findings[0].sharePercent, "0.1");
  eq(r.scan.transfersDecoded, 4);
  eq(r.scan.transfersRanked, 4);
  assert(!r.scan.partial);
});

await test("the threshold is applied in basis points, not wei", async () => {
  const chain = fakeChain(scanSpec);
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 10, limit: 20 });
  assert(r.ok);
  eq(r.findings.length, 2, "both 10 bps transfers survive a 10 bps threshold");
  for (const f of r.findings) eq(f.shareBps, 10);
});

await test("a wrong chain is refused before any log is read", async () => {
  const chain = fakeChain({ ...scanSpec, chainId: 1n });
  const r = await scan({ rpc: chain, hours: 1 });
  assert(!r.ok);
  eq(r.code, "WRONG_CHAIN");
  assert(!chain.calls.some((c) => c.method === "eth_getLogs"), "no logs read on the wrong chain");
});

await test("a scan where every chunk fails is an error, not an empty result", async () => {
  // The critical distinction: "nothing happened" and "I could not look" must
  // never both come back as ok with zero findings.
  const chain = fakeChain({ ...scanSpec, failFrom: new Set([4401]) });
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1 });
  assert(!r.ok);
  eq(r.code, "SCAN_UNAVAILABLE");
});

await test("a partial scan still returns rows but says it is partial", async () => {
  const chain = fakeChain({
    head: 5000,
    blockTime: 6,
    tokens,
    logs: scanSpec.logs,
    failFrom: new Set([4801]), // the newer chunk for a 2h window
  });
  const r = await scan({ rpc: chain, hours: 2, minShareBps: 1, limit: 20 });
  assert(r.ok);
  assert(r.scan.partial);
  eq(r.scan.failedChunkCount, 1);
  assert(r.findings.length > 0, "the readable chunk still produces findings");
});

await test("a token whose metadata cannot be read is reported, not formatted anyway", async () => {
  const chain = fakeChain({
    head: 5000,
    blockTime: 6,
    tokens: { [WPROS]: tokens[WPROS] }, // USDC answers nothing
    logs: scanSpec.logs,
  });
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1 });
  assert(r.ok);
  const reasons = r.skipped.map((s) => s.reason);
  assert(reasons.includes("DECIMALS_UNREADABLE"), `expected a skip reason, got ${JSON.stringify(reasons)}`);
  assert(r.findings.every((f) => f.token.symbol !== "USDC"));
});

await test("undecodable logs are counted with a reason", async () => {
  const bad = transferLog({ token: WPROS, from: POOL, to: WHALE, amount: 10n ** 21n, block: 4500 });
  bad.data = "0xdeadbeef";
  const chain = fakeChain({ head: 5000, blockTime: 6, tokens, logs: [bad] });
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1 });
  assert(r.ok);
  eq(r.findings.length, 0);
  eq(r.skipped[0].reason, "AMOUNT_DATA_NOT_ONE_WORD");
});

await test("an unreadable chain is RPC_UNAVAILABLE", async () => {
  const chain = { call: async () => { throw new Error("connection refused"); } };
  const r = await scan({ rpc: chain, hours: 1 });
  assert(!r.ok);
  eq(r.code, "RPC_UNAVAILABLE");
});

await test("the watchlist finds activity touching a watched address and builds a summary", async () => {
  const chain = fakeChain(scanSpec);
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1, watch: [WHALE, ALICE] });
  assert(r.ok);
  eq(r.watch.addresses.length, 2);
  eq(r.watch.summary.length, 2);
  const whaleSum = r.watch.summary.find((s) => s.address === WHALE);
  const aliceSum = r.watch.summary.find((s) => s.address === ALICE);
  assert(whaleSum && aliceSum);
  eq(whaleSum.status, "ACTIVE");
  eq(whaleSum.inCount, 1);
  eq(whaleSum.outCount, 0);
  eq(aliceSum.inCount, 2);
  eq(aliceSum.outCount, 1);
  assert(r.watch.activity.length >= 1);
  assert(typeof r.findings[0].explanation === "string" && r.findings[0].explanation.length > 0);
});

await test("omitting watch defaults to the 5 Pharos watched addresses", async () => {
  const chain = fakeChain(scanSpec);
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1 });
  assert(r.ok);
  eq(r.watch.addresses.length, DEFAULT_WATCHLIST.length);
  eq(r.watch.summary.length, DEFAULT_WATCHLIST.length);
});

await test("a mistyped watch address is refused, not silently watched", async () => {
  const chain = fakeChain(scanSpec);
  const r = await scan({ rpc: chain, hours: 1, watch: ["0x7a16ff8270133f063aab6c9977183d9e72835428"] });
  assert(r.ok, "all-lowercase is accepted");
  const bad = await scan({ rpc: chain, hours: 1, watch: ["0x7A16fF8270133F063aAb6C9977183D9e72835428"] });
  assert(!bad.ok);
  eq(bad.code, "BAD_WATCH_ADDRESS");
});

await test("parameters outside the limits are refused", async () => {
  const chain = fakeChain(scanSpec);
  eq((await scan({ rpc: chain, hours: 0 })).code, "BAD_HOURS");
  eq((await scan({ rpc: chain, hours: LIMITS.maxHours + 1 })).code, "BAD_HOURS");
  eq((await scan({ rpc: chain, hours: Number.NaN })).code, "BAD_HOURS");
  eq((await scan({ rpc: chain, minShareBps: 1.5 })).code, "BAD_THRESHOLD");
  eq((await scan({ rpc: chain, minShareBps: 10001 })).code, "BAD_THRESHOLD");
  eq((await scan({ rpc: chain, limit: 0 })).code, "BAD_LIMIT");
  eq((await scan({ rpc: chain, limit: 101 })).code, "BAD_LIMIT");
  eq((await scan({ rpc: chain, watch: new Array(21).fill(WHALE) })).code, "BAD_WATCH");
});

await test("a large window is capped rather than attempted", async () => {
  // 1s blocks on a 6h window would be 21600 blocks; the cap is what stops this
  // from becoming 22 sequential requests against a rate-limited endpoint.
  const chain = fakeChain({ ...scanSpec, head: 500000, blockTime: 1 });
  const r = await scan({ rpc: chain, hours: 6, minShareBps: 1 });
  assert(r.ok);
  assert(r.scan.blocksCapped);
  eq(r.scan.chunksPlanned, LIMITS.maxChunks);
});

await test("a capped window states the span it did not cover", async () => {
  // "hours: 6" is a request, not a result. With 1s blocks the cap allows 6000
  // blocks, which is 100 minutes — the report has to say 100 minutes, not 6h.
  const chain = fakeChain({ ...scanSpec, head: 500000, blockTime: 1 });
  const r = await scan({ rpc: chain, hours: 6, minShareBps: 1 });
  assert(r.ok);
  eq(r.scan.blocksCap, LIMITS.maxChunks * 1000);
  eq(r.scan.windowBlocks, LIMITS.maxChunks * 1000);
  eq(r.scan.windowSecondsRequested, 6 * 3600);
  assert(
    r.scan.windowSecondsCovered < r.scan.windowSecondsRequested,
    `covered ${r.scan.windowSecondsCovered}s must be less than requested ${r.scan.windowSecondsRequested}s`,
  );
  assert(r.scan.capTruncatedBlocks > 0);
  // The cap truncates the request, not the read: whatever was asked for inside
  // the cap was actually read.
  eq(r.scan.windowCoverageBps, 10000);
});

await test("a scan whose every token metadata read was throttled is not an empty market", async () => {
  // The failure mode this guards: transfers are found, none can be measured,
  // and the caller reads "0 findings" as "nothing big happened".
  const chain = fakeChain({
    ...scanSpec,
    failTokens: new Set([WPROS.toLowerCase(), USDC.toLowerCase()]),
  });
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1 });
  assert(!r.ok, "an unmeasurable scan must not return ok");
  eq(r.code, "METADATA_UNAVAILABLE");
  assert(r.error.includes("could be read"), r.error);
  eq(r.scan.tokensSeen, 2);
  assert(r.scan.metadataUnavailable > 0);
});

await test("a throttled token is counted as unmeasurable, not as not-ERC-20", async () => {
  const chain = fakeChain({
    ...scanSpec,
    failTokens: new Set([USDC.toLowerCase()]),
  });
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1 });
  assert(r.ok, r.error);
  assert(r.scan.degraded, "one unreadable token makes the ranking a subset");
  assert(r.scan.metadataUnavailable > 0);
  eq(r.scan.metadataInvalid, 0, "an outage is not an invalid contract");
  assert(r.scan.transfersUnranked > 0);
  // WPROS is still readable, so the scan is degraded but not empty.
  assert(r.findings.every((f) => f.token.symbol === "WPROS"));
  eq(r.scan.transfersRanked + r.scan.transfersUnranked, r.scan.transfersDecoded);
});

await test("a contract that answers nothing is invalid, not unavailable", async () => {
  const r = await readToken(
    { call: async () => "0x" },
    "0x3333333333333333333333333333333333333333",
  );
  eq(r.ok, false);
  eq(r.transient, false, "an empty answer is a verdict about the contract");
  eq(r.reason, "DECIMALS_UNREADABLE");
});

await test("a throttled metadata read is unavailable, not invalid", async () => {
  const r = await readToken(
    {
      call: async () => {
        throw Object.assign(new Error("cu limit exceeded"), { retryable: true });
      },
    },
    "0x4444444444444444444444444444444444444444",
  );
  eq(r.ok, false);
  eq(r.transient, true);
  assert(r.reason.startsWith("METADATA_UNAVAILABLE"), r.reason);
});

await test("findings cut by the row limit say how many were dropped", async () => {
  const chain = fakeChain(scanSpec);
  const r = await scan({ rpc: chain, hours: 1, minShareBps: 1, limit: 1 });
  assert(r.ok);
  eq(r.scan.findingsReturned, 1);
  eq(r.scan.findingsMatched, 3);
  eq(r.scan.findingsTruncated, 2);
});

report();
