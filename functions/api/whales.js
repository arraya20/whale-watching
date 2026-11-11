// GET /api/whales — read-only scan of large token movements on Pharos.
//
// The request carries intent only: how far back, how large counts as large, how
// many rows, and an optional watchlist. It cannot carry transfers, amounts,
// balances, token metadata or a verdict. Everything factual is read from the
// chain by the scan.
//
// That constraint is the fix for the scaffold's worst property: its
// `inspectTransferForWhaleMove(payload)` accepted `from`, `to`, `amountWei` and
// even `watchedAddresses` from the caller, so the caller defined what a whale
// was and the "detection" was arithmetic over the caller's own claim. A tracker
// that believes its requester is not a tracker.

import { scan, LIMITS } from "../../src/scan.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

// A request the caller must fix.
const BAD_REQUEST = new Set([
  "BAD_HOURS",
  "BAD_THRESHOLD",
  "BAD_LIMIT",
  "BAD_WATCH",
  "BAD_WATCH_ADDRESS",
]);

// The chain could not be read. Not the caller's fault, and definitely not a
// finding of "nothing happened".
const UPSTREAM = new Set([
  "RPC_UNAVAILABLE",
  "BLOCK_TIME_UNAVAILABLE",
  "SCAN_UNAVAILABLE",
  // Transfers were read but no token contract could tell us its supply. That is
  // the endpoint failing us, not a quiet market, so it must not read as 500 or
  // as an empty 200.
  "METADATA_UNAVAILABLE",
]);

// The endpoint is not the chain this tool understands.
const CONFLICT = new Set(["WRONG_CHAIN"]);

const FORBIDDEN_FIELDS = [
  "from",
  "to",
  "amount",
  "amountWei",
  "amountRaw",
  "transfers",
  "logs",
  "symbol",
  "decimals",
  "totalSupply",
  "balance",
  "balances",
  "verdict",
  "findings",
  "watchedAddresses",
];

function parseNumber(raw, fallback) {
  if (raw === null || raw === "") return fallback;
  if (!/^-?[0-9]+$/.test(raw)) return NaN;
  return Number(raw);
}

// `hours` takes one decimal place so a 15-minute window is expressible. Anything
// looser (Number(), parseFloat) also accepts "1e3", " 1", "0x10" and "1.2.3",
// which is a parameter parser deciding what the caller meant.
function parseHours(raw, fallback) {
  if (raw === null || raw === "") return fallback;
  if (!/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(raw)) return NaN;
  return Number(raw);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const params = url.searchParams;

  // Refuse attempts to supply the facts. Echoing a helpful "ignored" reply would
  // still mean the caller believes it set them.
  const supplied = FORBIDDEN_FIELDS.filter((f) => params.has(f));
  if (supplied.length > 0) {
    return json(
      {
        ok: false,
        code: "CALLER_SUPPLIED_FACTS",
        error:
          `This endpoint reads every fact from the chain. It does not accept: ${supplied.join(", ")}. ` +
          `Send only hours, minShareBps, limit and watch.`,
      },
      400,
    );
  }

  const rawWatch = params.getAll("watch").map((v) => v.trim()).filter(Boolean);
  const options = {
    hours: parseHours(params.get("hours"), 1),
    minShareBps: parseNumber(params.get("minShareBps"), 1),
    limit: parseNumber(params.get("limit"), 20),
    ...(rawWatch.length > 0 ? { watch: rawWatch } : {}),
    rpcUrl: env?.PHAROS_RPC_URL || undefined,
  };

  if (Number.isNaN(options.hours)) {
    return json({ ok: false, code: "BAD_REQUEST", error: "hours must be a number like 1 or 0.5" }, 400);
  }
  if (Number.isNaN(options.minShareBps) || Number.isNaN(options.limit)) {
    return json({ ok: false, code: "BAD_REQUEST", error: "minShareBps and limit must be integers" }, 400);
  }

  let result;
  try {
    result = await scan(options);
  } catch (e) {
    // An unexpected throw is still not an empty result.
    return json({ ok: false, code: "INTERNAL", error: e.message }, 500);
  }

  if (!result.ok) {
    const status = BAD_REQUEST.has(result.code) ? 400 : UPSTREAM.has(result.code) ? 502 : CONFLICT.has(result.code) ? 409 : 500;
    return json(result, status);
  }

  // Partial reads are returned with 200 because the rows that are present are
  // real, but the body says plainly that a gap exists.
  return json({ ...result, limits: LIMITS }, 200);
}

export const onRequest = ({ request, env, params, waitUntil }) => {
  if (request.method !== "GET") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "use GET" }, 405);
  }
  return onRequestGet({ request, env, params, waitUntil });
};
