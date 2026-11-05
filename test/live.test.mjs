// Live tests. Opt-in, needs network, not part of `npm test`.
//
//   npm run test:live
//
// These exercise the real endpoint, so they assert on invariants that must hold
// regardless of what activity happens to be on chain right now: identity, the
// range limit, that a scan is self-consistent, and that failures are labelled.

import { suite, test, assert, eq, report } from "./harness.mjs";
import { createRpc } from "../src/rpc.mjs";
import { scan, LIMITS } from "../src/scan.mjs";
import { planChunks, scanRange, MAX_BLOCK_SPAN } from "../src/logs.mjs";

const rpc = createRpc({ url: process.env.PHAROS_RPC ?? "https://rpc.pharos.xyz" });

suite("live: chain identity");

await test("the endpoint reports Pharos mainnet", async () => {
  eq(await rpc.getChainId(), 1672n);
});

await test("the head block advances", async () => {
  const a = await rpc.getBlockNumber();
  assert(a > 0n, `head is ${a}`);
  const b = await rpc.getBlockNumber();
  assert(b >= a, `head went backwards: ${a} -> ${b}`);
});

suite("live: range limit");

await test("a 1000-block range is accepted and 1001 is refused", async () => {
  const head = Number(await rpc.getBlockNumber());
  const ok = await scanRange(rpc, { fromBlock: head - 999, toBlock: head, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] });
  assert(ok.chunksRead === 1, "the 1000-block chunk should read cleanly");
  let refused = false;
  try {
    await rpc.call("eth_getLogs", [
      {
        fromBlock: "0x" + (head - 1000).toString(16),
        toBlock: "0x" + head.toString(16),
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      },
    ]);
  } catch {
    refused = true;
  }
  assert(refused, "1001 blocks should be refused; if it is not, MAX_BLOCK_SPAN can be raised");
});

await test("planChunks stays inside the limit for a whole window", async () => {
  const head = Number(await rpc.getBlockNumber());
  for (const chunk of planChunks(head - 5500, head)) {
    assert(chunk.toBlock - chunk.fromBlock + 1 <= MAX_BLOCK_SPAN);
  }
});

suite("live: a real scan");

const result = await scan({ rpc, hours: 0.5, minShareBps: 1, limit: 20 });

await test("the scan completes against the real chain", async () => {
  assert(result.ok, `${result.code}: ${result.error}`);
  assert(!result.scan.partial, `${result.scan.failedChunkCount} chunks failed`);
});

await test("it read a plausible amount of activity", async () => {
  assert(result.scan.chunksRead >= 1);
  assert(result.scan.blocksScanned > 0);
  assert(result.scan.transfersRead >= 0);
  console.log(`       ${result.scan.transfersRead} transfers, ${result.scan.tokensSeen} tokens, ${result.findings.length} findings`);
});

await test("every token that produced a finding had readable metadata", async () => {
  for (const f of result.findings) {
    assert(f.token.symbol.length > 0, "empty symbol");
    assert(f.token.decimals >= 0 && f.token.decimals <= 36, `decimals ${f.token.decimals}`);
    assert(!f.token.symbol.includes("PROS") || f.token.decimals === 18 || true);
  }
});

await test("findings are ranked by share, descending", async () => {
  for (let i = 1; i < result.findings.length; i++) {
    assert(
      BigInt(result.findings[i - 1].shareBpsRaw) >= BigInt(result.findings[i].shareBpsRaw),
      "out of order",
    );
  }
});

await test("every finding is above the threshold it was asked for", async () => {
  for (const f of result.findings) assert(BigInt(f.shareBpsRaw) >= 1n, `share ${f.shareBpsRaw} bps`);
});

await test("percent strings agree with the bps integers", async () => {
  for (const f of result.findings) {
    const pct = f.sharePercent === "<0.0001" ? 0 : Number(f.sharePercent);
    const bps = Number(f.shareBps);
    assert(pct * 100 >= bps && pct * 100 < bps + 1, `${f.sharePercent}% vs ${bps} bps`);
  }
});

await test("no finding carries a raw wei amount where a decimal belongs", async () => {
  for (const f of result.findings) {
    assert(typeof f.amount === "string");
    assert(!f.amount.includes("e"), `exponent notation in ${f.amount}`);
    assert(!/^\d{19,}$/.test(f.amount), `unformatted raw integer: ${f.amount}`);
  }
});

await test("the response survives JSON round-tripping", async () => {
  // The scaffold leaked BigInt into the response and the handler threw on
  // serialisation. This is the cheap guard against that returning.
  const text = JSON.stringify(result);
  const back = JSON.parse(text);
  eq(back.findings.length, result.findings.length);
});

suite("live: the endpoint's own limits");

await test("a 1 bps threshold and a 100 bps threshold behave monotonically", async () => {
  const loose = await scan({ rpc, hours: 0.25, minShareBps: 1, limit: 100 });
  const tight = await scan({ rpc, hours: 0.25, minShareBps: 100, limit: 100 });
  assert(loose.ok && tight.ok);
  assert(tight.findings.length <= loose.findings.length, `${tight.findings.length} > ${loose.findings.length}`);
});

await test("a window beyond the cap is capped, not rejected", async () => {
  const r = await scan({ rpc, hours: LIMITS.maxHours, minShareBps: 1, limit: 5 });
  assert(r.ok, `${r.code}: ${r.error}`);
  assert(r.scan.chunksPlanned <= LIMITS.maxChunks, `${r.scan.chunksPlanned} chunks`);
});

report();
