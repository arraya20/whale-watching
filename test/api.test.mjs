import { suite, test, assert, eq, report, fakeChain, transferLog, installFetch } from "./harness.mjs";
import { onRequest } from "../functions/api/whales.js";
import { LIMITS } from "../src/scan.mjs";

const WPROS = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const WHALE = "0x7a16fF8270133F063aAb6C9977183D9e72835428";
const POOL = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";

const tokens = {
  [WPROS]: { symbol: "WPROS", decimals: 18, totalSupply: 10n ** 24n },
  [USDC]: { symbol: "USDC", decimals: 6, totalSupply: 10n ** 12n },
};

const goodLogs = [
  transferLog({ token: WPROS, from: POOL, to: WHALE, amount: 10n ** 21n, block: 4500, logIndex: 0 }),
  transferLog({ token: USDC, from: POOL, to: WHALE, amount: 10n ** 9n, block: 4600, logIndex: 1 }),
];

function chainFor(overrides = {}) {
  return fakeChain({ head: 5000, blockTime: 6, tokens, logs: goodLogs, ...overrides });
}

async function get(query, chain = chainFor(), env = {}) {
  const restore = installFetch(chain.fetchStub);
  try {
    const request = new Request(`https://tracker.test/api/whales${query}`);
    const res = await onRequest({ request, env });
    const body = await res.json();
    return { status: res.status, body, cacheControl: res.headers.get("cache-control") };
  } finally {
    restore();
  }
}

suite("API: read-only scan");

await test("a scan returns ranked findings, default 5 watched addresses, and the limits", async () => {
  const { status, body } = await get("?hours=1&minShareBps=1&limit=20");
  eq(status, 200);
  assert(body.ok, JSON.stringify(body));
  eq(body.findings.length, 2);
  eq(body.findings[0].sharePercent, "0.1");
  assert(body.findings[0].explanation.includes(body.findings[0].token.symbol));
  assert(body.watch.addresses.length >= 5);
  eq(body.watch.summary.length, body.watch.addresses.length);
  eq(body.limits.maxHours, LIMITS.maxHours);
  eq(body.scan.chainId, 1672);
});

await test("responses are not cached", async () => {
  const { cacheControl } = await get("?hours=1");
  eq(cacheControl, "no-store");
});

await test("the caller cannot supply the facts", async () => {
  // The scaffold's predicate took from/to/amountWei straight from the request.
  const { status, body } = await get("?hours=1&from=0xabc&to=0xdef&amountWei=999");
  eq(status, 400);
  eq(body.code, "CALLER_SUPPLIED_FACTS");
  assert(body.error.includes("from"));
});

await test("a caller-supplied watchlist under the scaffold's name is refused", async () => {
  const { status, body } = await get("?hours=1&watchedAddresses=0xabc");
  eq(status, 400);
  eq(body.code, "CALLER_SUPPLIED_FACTS");
});

await test("a caller-supplied verdict is refused", async () => {
  const { status, body } = await get("?verdict=whale");
  eq(status, 400);
  eq(body.code, "CALLER_SUPPLIED_FACTS");
});

suite("API: parameters");

await test("non-integer parameters are 400", async () => {
  const { status, body } = await get("?hours=abc");
  eq(status, 400);
  eq(body.code, "BAD_REQUEST");
});

await test("a fractional window is accepted", async () => {
  // 15 minutes is the window an operator actually watches. Requiring whole hours
  // would have forced the smallest scan to be four times too wide.
  const { status, body } = await get("?hours=0.25&minShareBps=1");
  eq(status, 200);
  assert(body.ok, JSON.stringify(body));
  eq(body.scan.blockTimeSeconds > 0, true);
});

await test("a window written as anything other than a plain number is 400", async () => {
  // "1e3" and " 1" both parse with Number(); neither is what the caller meant.
  for (const raw of ["1e3", "0x10", "1.2.3", "-1", "%201"]) {
    const { status, body } = await get(`?hours=${raw}`);
    eq(status, 400, `hours=${raw} should be refused`);
    assert(body.code === "BAD_REQUEST" || body.code === "BAD_HOURS", `${raw}: ${body.code}`);
  }
});

await test("an out-of-range window is 400 with the limit named", async () => {
  const { status, body } = await get("?hours=99");
  eq(status, 400);
  eq(body.code, "BAD_HOURS");
  assert(body.error.includes(String(LIMITS.maxHours)));
});

await test("a bad watch address is 400, not ignored", async () => {
  const { status, body } = await get("?watch=0x7A16fF8270133F063aAb6C9977183D9e72835428");
  eq(status, 400);
  eq(body.code, "BAD_WATCH_ADDRESS");
});

await test("repeated watch parameters become a watchlist", async () => {
  const { status, body } = await get(`?hours=1&watch=${WHALE}&watch=${POOL}`);
  eq(status, 200);
  eq(body.watch.addresses.length, 2);
});

suite("API: upstream failures are not empty results");

await test("a wrong chain is 409", async () => {
  const { status, body } = await get("?hours=1", chainFor({ chainId: 1n }));
  eq(status, 409);
  eq(body.code, "WRONG_CHAIN");
});

await test("an unreadable chain is 502", async () => {
  const chain = {
    fetchStub: async (url, init) => {
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { status, body } = await get("?hours=1", chain);
  eq(status, 502);
  eq(body.code, "RPC_UNAVAILABLE");
});

await test("a scan where every range failed is 502, not a 200 with no rows", async () => {
  // The failure this whole design exists to prevent: an all-chunks-failed scan
  // reported as "no whales today".
  const chain = {
    fetchStub: async (url, init) => {
      const b = JSON.parse(init.body);
      if (b.method === "eth_getLogs") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "block range too large" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const result =
        b.method === "eth_chainId"
          ? "0x688"
          : b.method === "eth_blockNumber"
            ? "0x1388"
            : { timestamp: "0x" + (BigInt(b.params[0]) * 6n).toString(16) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const { status, body } = await get("?hours=1", chain);
  eq(status, 502);
  eq(body.code, "SCAN_UNAVAILABLE");
});

await test("a partial scan is 200 but says it is partial", async () => {
  const { status, body } = await get("?hours=2&minShareBps=1", chainFor({ failFrom: new Set([4801]) }));
  eq(status, 200);
  assert(body.scan.partial);
  eq(body.scan.failedChunkCount, 1);
  assert(body.findings.length > 0);
});

await test("transfers whose token metadata was throttled are 502, not an empty 200", async () => {
  // Same shape as the all-chunks-failed case, one layer up: the logs arrived,
  // the contracts did not answer, and "no whales" would be a lie about the chain.
  const chain = fakeChain({
    head: 5000,
    blockTime: 6,
    tokens,
    logs: goodLogs,
    failTokens: new Set(Object.keys(tokens).map((a) => a.toLowerCase())),
  });
  const { status, body } = await get("?hours=1", chain);
  eq(status, 502);
  eq(body.code, "METADATA_UNAVAILABLE");
  assert(body.scan.transfersRead > 0, "the transfers were seen, which is why this is not an empty window");
});

await test("a degraded scan is 200 but reports what it could not measure", async () => {
  const [first] = Object.keys(tokens);
  const chain = fakeChain({
    head: 5000,
    blockTime: 6,
    tokens,
    logs: goodLogs,
    failTokens: new Set(Object.keys(tokens).filter((a) => a !== first).map((a) => a.toLowerCase())),
  });
  const { status, body } = await get("?hours=1&minShareBps=1", chain);
  eq(status, 200);
  assert(body.scan.degraded, "a subset ranking must be labelled");
  assert(body.scan.metadataUnavailable > 0);
  assert(body.scan.transfersUnranked > 0);
});

suite("API: native PROS");

await test("minPros is accepted and returned in the threshold", async () => {
  const { status, body } = await get("?hours=1&minPros=2");
  eq(status, 200);
  eq(body.threshold.minPros, "2");
  assert(body.scan.native, "native scan should be present when a watchlist exists");
});

await test("the caller cannot supply native value facts", async () => {
  const { status, body } = await get("?hours=1&value=123");
  eq(status, 400);
  eq(body.code, "CALLER_SUPPLIED_FACTS");
  const nv = await get("?hours=1&nativeValue=123");
  eq(nv.status, 400);
  eq(nv.body.code, "CALLER_SUPPLIED_FACTS");
});

suite("API: method");

await test("a non-GET method is 405", async () => {
  const request = new Request("https://tracker.test/api/whales", { method: "POST" });
  const res = await onRequest({ request, env: {} });
  eq(res.status, 405);
});

report();
