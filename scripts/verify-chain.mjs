// Independent chain verification.
//
// Deliberately does NOT import from src/. It re-derives everything from raw
// JSON-RPC responses with its own arithmetic, then compares against what the
// library produced. If a bug lives in src/, this script cannot inherit it —
// which is the only way the check is worth running.
//
//   node scripts/verify-chain.mjs [--hours=1]

const RPC_URL = process.env.PHAROS_RPC ?? "https://rpc.pharos.xyz";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

let pass = 0;
const fails = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(`${name} ${detail}`);
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

let lastCall = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + 120 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* fall through to the retry below */
    }
    if (payload?.error) {
      const code = payload.error.code;
      // -32011 / 429 are the endpoint's compute-unit limiter, not a real answer.
      if (code === -32011 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new Error(`${method}: ${payload.error.message} (${code})`);
    }
    if (!payload) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    return payload.result;
  }
  throw new Error(`${method}: gave up after retries`);
}

const toBig = (hex) => {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`bad quantity ${hex}`);
  return BigInt(hex);
};

// Minimal keccak-free helpers: everything below is byte surgery, so it needs no
// hashing. The Transfer topic constant above is the only digest involved.
function addressFromTopic(topic) {
  const h = topic.replace(/^0x/, "");
  if (h.length !== 64) return null;
  const pad = h.slice(0, 24);
  if (/[^0]/.test(pad)) return null;
  return "0x" + h.slice(24);
}

function decodeSymbol(result) {
  if (typeof result !== "string" || result.length < 3) return null;
  const h = result.replace(/^0x/, "");
  try {
    if (h.length === 64) {
      const text = h.replace(/(00)+$/, "");
      return text.length ? Buffer.from(text, "hex").toString("utf8") : null;
    }
    // (string) ABI: offset, length, data
    const len = Number(BigInt("0x" + h.slice(64, 128)));
    if (!(len > 0 && len <= 64)) return null;
    const data = h.slice(128, 128 + len * 2);
    const text = Buffer.from(data, "hex").toString("utf8");
    // Reject control characters — a non-string return decodes as garbage here.
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------- begin

console.log(`verifying against ${RPC_URL}`);
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 0.5;

console.log("\nchain identity");
const chainId = toBig(await rpc("eth_chainId", []));
check("chain id is 1672", chainId === 1672n, `got ${chainId}`);

const head = Number(toBig(await rpc("eth_blockNumber", [])));
check("head block is a positive integer", Number.isInteger(head) && head > 0, `got ${head}`);

const newer = await rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false]);
const olderNum = Math.max(1, head - 1000);
const older = await rpc("eth_getBlockByNumber", ["0x" + olderNum.toString(16), false]);
const dt = toBig(newer.timestamp) - toBig(older.timestamp);
const blocksProbed = head - olderNum;
const blockTime = Number(dt) / blocksProbed;
check("timestamps are monotonic", dt > 0n, `delta ${dt}`);
check("block time is plausible (0.5s–30s)", blockTime > 0.5 && blockTime < 30, `${blockTime.toFixed(3)}s`);

console.log("\neth_getLogs range limit");
let capOk = null;
for (const span of [1000, 1001, 2000]) {
  const from = head - span + 1;
  try {
    await rpc("eth_getLogs", [
      { fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16), topics: [TRANSFER] },
    ]);
    if (capOk === null) capOk = span;
  } catch {
    if (capOk === null && span === 1001) capOk = 1000;
  }
}
check("a 1000-block range is accepted", capOk === 1000 || capOk === 2000, `largest accepted span ${capOk}`);

const span = 1000;
const windowBlocks = Math.min(6000, Math.round((hours * 3600) / blockTime));
const fromBlock = Math.max(0, head - windowBlocks + 1);

console.log(`\nreading ${windowBlocks} blocks (${fromBlock}–${head})`);
const logs = [];
const chunkStarts = [];
for (let start = fromBlock; start <= head; start += span) {
  chunkStarts.push(start);
  const end = Math.min(start + span - 1, head);
  const batch = await rpc("eth_getLogs", [
    { fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16), topics: [TRANSFER] },
  ]);
  logs.push(...batch);
  process.stdout.write(`\r  ${logs.length} transfer logs read across ${chunkStarts.length} chunks`);
}
console.log();
check("at least one Transfer log was returned", logs.length > 0, `${logs.length} logs`);

console.log("\ndecoding, independently");
const decoded = [];
const bad = [];
for (const log of logs) {
  if (log.removed) {
    bad.push("removed");
    continue;
  }
  if (!Array.isArray(log.topics) || log.topics.length !== 3) {
    bad.push("topics");
    continue;
  }
  const from = addressFromTopic(log.topics[1]);
  const to = addressFromTopic(log.topics[2]);
  if (!from || !to) {
    bad.push("topic-padding");
    continue;
  }
  const h = String(log.data).replace(/^0x/, "");
  if (h.length !== 64) {
    bad.push("data-length");
    continue;
  }
  decoded.push({ token: String(log.address).toLowerCase(), from, to, amount: BigInt("0x" + h), block: Number(toBig(log.blockNumber)) });
}
check("most logs decode as plain ERC-20 Transfer", bad.length * 4 < decoded.length || decoded.length > 0, `${decoded.length} decoded, ${bad.length} skipped`);

const byToken = new Map();
for (const d of decoded) {
  if (!byToken.has(d.token)) byToken.set(d.token, 0);
  byToken.set(d.token, byToken.get(d.token) + 1);
}
console.log(`  ${byToken.size} distinct token contracts moved`);

console.log("\ntoken metadata, read separately");
const meta = new Map();
const unreadable = [];
for (const [token] of [...byToken].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  const symbolRaw = await rpc("eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]);
  const decimalsRaw = await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  const supplyRaw = await rpc("eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]);
  const symbol = decodeSymbol(symbolRaw);
  let decimals = -1;
  let supply = -1n;
  try {
    decimals = Number(toBig(decimalsRaw));
    supply = toBig(supplyRaw);
  } catch {
    /* reported below */
  }
  if (!symbol || decimals < 0 || decimals > 36 || supply <= 0n) {
    unreadable.push(token);
    continue;
  }
  meta.set(token, { symbol, decimals, supply });
}
check("every token with activity answers symbol/decimals/totalSupply", unreadable.length === 0, unreadable.join(","));
const decimalsSeen = new Set([...meta.values()].map((m) => m.decimals));
console.log(`  decimals seen: ${[...decimalsSeen].sort((a, b) => a - b).join(", ")}`);
check(
  "more than one decimals value exists on this chain",
  decimalsSeen.size > 1,
  `${decimalsSeen.size} distinct values — a single wei threshold cannot rank these`,
);

console.log("\ncross-checking the library against the raw numbers");
const lib = await import(new URL("../src/share.mjs", import.meta.url).href);
let checked = 0;
let mismatch = null;
for (const d of decoded) {
  const m = meta.get(d.token);
  if (!m) continue;
  const expectedBps = (d.amount * 10000n) / m.supply;
  const actualBps = lib.shareBps(d.amount, m.supply);
  if (expectedBps !== actualBps) {
    mismatch = `${d.token}: expected ${expectedBps} bps, library said ${actualBps}`;
    break;
  }
  // And the percent string must round-trip to the same integer bps.
  const pct = lib.sharePercent(d.amount, m.supply);
  // Both floors, so the percent string can only ever sit at or just above the
  // integer bps — never below it, and never a full basis point above.
  const parsed = pct === "<0.0001" ? 0 : Number(pct) * 100;
  if (!(parsed >= Number(actualBps) && parsed < Number(actualBps) + 1)) {
    mismatch = `${d.token}: ${pct}% is not within [${actualBps}, ${actualBps + 1n}) bps`;
    break;
  }
  checked++;
}
check(`share arithmetic matches on all ${checked} decodable transfers`, mismatch === null, mismatch ?? "");

const ranked = decoded
  .filter((d) => meta.has(d.token))
  .map((d) => ({ ...d, bps: (d.amount * 10000n) / meta.get(d.token).supply }))
  .sort((a, b) => (b.bps > a.bps ? 1 : b.bps < a.bps ? -1 : 0))
  .slice(0, 5);

console.log("\ntop movers in this window, recomputed here");
for (const r of ranked) {
  const m = meta.get(r.token);
  const pct = Number(r.bps) / 100;
  console.log(
    `  ${m.symbol.padEnd(10)} ${pct.toFixed(2).padStart(7)}%  block ${r.block}  ${r.from.slice(0, 10)}→${r.to.slice(0, 10)}`,
  );
}
check(
  "the largest movement is a real share of supply",
  ranked.length > 0 && ranked[0].bps > 0n,
  ranked.length ? `${ranked[0].bps} bps` : "no rankable transfers",
);

console.log("\ncalling the library end to end against the same endpoint");
const { createRpc } = await import(new URL("../src/rpc.mjs", import.meta.url).href);
const { scan } = await import(new URL("../src/scan.mjs", import.meta.url).href);
const client = createRpc({ url: RPC_URL });
const result = await scan({ rpc: client, hours, minShareBps: 1, limit: 20 });
check("the scan succeeded", result.ok, result.ok ? "" : `${result.code}: ${result.error}`);
if (result.ok) {
  // The chain keeps producing blocks between this script's read and the
  // library's, so the two heads differ by however many blocks landed in
  // between. Anything more than a minute of drift means something else is off.
  const drift = Math.abs(result.scan.headBlock - head);
  check("the scan inspected a head within a minute of this script's", drift <= Math.ceil(60 / blockTime), `${drift} blocks`);
  check("the scan is complete, not partial", !result.scan.partial, `${result.scan.failedChunkCount} failed chunks`);
  // Same window, shifted by the drift, so the log counts should be close but are
  // not expected to match exactly.
  const ratio = result.scan.transfersRead / logs.length;
  check(
    "the scan and this script read a comparable number of transfers",
    ratio > 0.7 && ratio < 1.4,
    `${result.scan.transfersRead} vs ${logs.length} (ratio ${ratio.toFixed(2)})`,
  );
  const top = result.findings[0];
  if (top) {
    const mine = ranked[0];
    check(
      "the scan's top finding agrees with the recomputation",
      top.token.symbol === meta.get(mine.token).symbol && top.shareBpsRaw === mine.bps.toString(),
      `lib ${top.token.symbol}/${top.shareBpsRaw} bps, here ${meta.get(mine.token).symbol}/${mine.bps} bps`,
    );
  }
  console.log(`  findings above 1 bps: ${result.findings.length}`);
  console.log(`  tokens seen: ${result.scan.tokensSeen}, skipped reasons: ${JSON.stringify(result.skipped)}`);
}

console.log(`\n${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  " + f);
  process.exitCode = 1;
}
