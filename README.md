# Whale watching agent

A read-only tracker for large token movements on Pharos (chain 1672). It scans
`Transfer` logs over a recent block window, ranks each transfer by **share of
that token's total supply**, and reports the largest movers plus anything
touching an address you are watching.

It holds no keys, signs nothing, and broadcasts nothing. `GET /api/whales` is the
whole surface.

## Why share of supply, not a wei threshold

A single threshold in wei cannot rank tokens that have different decimals, and on
this chain they do — verified against the live endpoint: **6** (USDC), **8**
(BTCVP), **18** (WPROS, pPROS, pCARR and the rest). A threshold of `1000e18`
therefore means 1000 WPROS but 1,000,000,000,000 USDC: one rule, two meanings, and
the USDC side can never fire.

Every ranked transfer is normalised the same way:

```
shareBps = amount * 10000 / totalSupply      (integer division, floored)
```

`decimals` cancels out of that expression, so 1000 USDC and 1000 WPROS at the same
share land on the same number. The threshold is expressed in basis points: `1` =
0.01% of supply, `100` = 1%.

The exact fraction is kept as `amountRaw` (integer, in base units), `amountExact`
(full decimal), and `shareBpsRaw` (integer, as a decimal string). The `amount` and
`sharePercent` fields are display values: truncated, never rounded up, so a
displayed number can only ever be smaller than the real one.

## Endpoint

```
GET /api/whales?hours=1&minShareBps=1&watch=0x75E54ACb9107Cc35969b44Eb6342F50686b3A12d
```

| parameter     | meaning                              | bounds                                      |
| ------------- | ------------------------------------ | ------------------------------------------- |
| `hours`       | how far back to scan                 | 0.05 – 6, up to 2 dp                        |
| `minShareBps` | minimum share of supply, in bps      | integer 0 – 10000                           |
| `minPros`     | minimum native PROS value to report  | decimal string, `0` to any exact amount     |
| `limit`       | maximum findings returned            | integer 1 – 100                             |
| `watch`       | address to watch (repeatable)        | max 20, EIP-55 required (defaults to 5)     |

The caller supplies **intent only**. Supplying a fact — `from`, `to`, `amountWei`,
`value`, `nativeValue`, `decimals`, `totalSupply`, `verdict`, `watchedAddresses`
and similar names — is refused with `400 CALLER_SUPPLIED_FACTS` rather than
ignored, because an ignored fact still leaves the caller believing it was applied.

### Response

```jsonc
{
  "ok": true,
  "scan": {
    "chainId": 1672,
    "headBlock": 22156107,
    "fromBlock": 22152891,
    "blocksRequested": 3217,
    "blocksCap": 6000,
    "windowBlocks": 3217,
    "blocksScanned": 3217,
    "blocksCapped": false,
    "capTruncatedBlocks": 0,
    "windowCoverageBps": 10000,
    "windowSecondsCovered": 3600,
    "windowSecondsRequested": 3600,
    "blockTimeSeconds": 1.119,
    "chunksPlanned": 4,
    "chunksRead": 4,
    "failedChunks": [],
    "partial": false,
    "transfersRead": 772,
    "transfersDecoded": 772,
    "transfersRanked": 772,
    "tokensSeen": 12,
    "durationMs": 8424
  },
  "threshold": { "minShareBps": 1 },
  "findings": [
    {
      "token": { "address": "0x…", "symbol": "PROPRO", "decimals": 18, "totalSupply": "…" },
      "kind": "TRANSFER",
      "from": "0x707E665B1a46319AB82AF7E300F0c92b3a279325",
      "fromLabel": "PROPRO Active Mover",
      "to": "0x75E54ACb9107Cc35969b44Eb6342F50686b3A12d",
      "toLabel": "PROPRO Liquidity Counterparty",
      "amountRaw": "528479988729089059",
      "amount": "0.528479",
      "amountExact": "0.528479988729089059",
      "shareBpsRaw": "86",
      "shareBps": 86,
      "sharePercent": "0.8653",
      "explanation": "Moved 0.528479 PROPRO (0.8653% of supply) from 0x707E665B1a46319AB82AF7E300F0c92b3a279325 (PROPRO Active Mover) to 0x75E54ACb9107Cc35969b44Eb6342F50686b3A12d (PROPRO Liquidity Counterparty)",
      "blockNumber": 22154961,
      "logIndex": 12,
      "txHash": "0x…"
    }
  ],
  "watch": {
    "addresses": ["0x707E665B1a46319AB82AF7E300F0c92b3a279325", "…"],
    "summary": [
      {
        "address": "0x707E665B1a46319AB82AF7E300F0c92b3a279325",
        "label": "PROPRO Active Mover",
        "inCount": 0,
        "outCount": 1,
        "totalTouches": 1,
        "significantTouches": 1,
        "maxShareBps": 86,
        "tokens": ["PROPRO"],
        "status": "ACTIVE"
      }
    ],
    "activity": []
  },
  "skipped": [{ "reason": "AMOUNT_DATA_NOT_ONE_WORD", "count": 3 }],
  "limits": { "maxHours": 6, "maxChunks": 6, "maxLimit": 100, "maxWatch": 20 }
}
```

`kind` is `TRANSFER`, `MINT` (from the zero address), `BURN` (to it) or `SELF`.
Native findings use `NATIVE_OUT`, `NATIVE_IN` and `NATIVE_SELF` instead.

## Fail-closed behaviour

The distinction this tool is built around: **"nothing happened" and "I could not
look" must never be the same answer.**

| situation                              | response                                   |
| -------------------------------------- | ------------------------------------------ |
| every chunk failed to read             | `502 SCAN_UNAVAILABLE`                     |
| some chunks failed, some succeeded     | `200`, `partial: true`, gaps listed        |
| endpoint is not chain 1672             | `409 WRONG_CHAIN`, no logs read            |
| RPC unreachable                        | `502 RPC_UNAVAILABLE`                      |
| `totalSupply` is zero                  | token skipped as `TOTAL_SUPPLY_ZERO`       |
| every token's metadata was throttled   | `502 METADATA_UNAVAILABLE`                 |
| some tokens' metadata was throttled    | `200`, `degraded: true`, `transfersUnranked` |
| token does not answer `decimals()`     | token skipped as `DECIMALS_UNREADABLE`     |
| log amount is not exactly one word     | skipped as `AMOUNT_DATA_NOT_ONE_WORD`      |
| log is marked `removed` (reorg)        | skipped as `REORGED`                       |
| log has more than 3 topics             | skipped as `NONSTANDARD_TOPICS`            |
| address topic has dirty padding        | skipped as `TOPIC_DIRTY_PADDING`           |

A skipped transfer is counted with its reason and left out of the ranking. It is
never shown with a guessed amount, symbol or decimals.

Metadata failures are split the same way, because "the contract answered nothing"
and "the endpoint would not let us ask" are opposite facts. An unusable answer
(`DECIMALS_UNREADABLE`, `TOTAL_SUPPLY_ZERO`) is a verdict about the contract. A
throttled `eth_call` is `METADATA_UNAVAILABLE`, is counted in
`scan.metadataUnavailable` rather than `metadataInvalid`, and if every token in
the window is unmeasurable the scan fails with `502` instead of returning an empty
ranking — transfers that were seen but cannot be measured are not an empty market.

## Two endpoint limits, measured

Both were found by probing, not from documentation, and both shape the design:

1. **`eth_getLogs` refuses a range of 1001 blocks or more** (`-32602 The block
   range is too large`); 1000 works. A window is therefore converted to a block
   range and split into 1000-block chunks.
2. **The endpoint rate-limits by compute unit** (`-32011`, and plain `429`). The
   RPC client serialises calls with a minimum spacing and backs off on those two
   codes. Chunk fetches run sequentially for the same reason.

Block time is *measured* per scan from two block timestamps rather than assumed,
because it is not 12s and not 6s — the live sample above came back at 1.119s.

## Native PROS

ERC-20 movement is read from `Transfer` logs, but native PROS has no log: its
`value` lives only in a transaction's block body. Native PROS (chain 1672, 18
decimals) is therefore read with `eth_getBlockByNumber(n, true)` over a bounded
window and filtered to transactions paying or collecting a watched address.

- The native transfer scan is capped at `NATIVE_MAX_BLOCKS = 600` (a measured
  ceiling, well below the 6000-block ERC-20 cap), read in JSON-RPC batches of 100
  at concurrency 2. Per-address `nativeBalance` and `nativeDelta` are read from
  `eth_getBalance` at the start and end of the **full requested window**, so the
  PROS Δ column is honest for `hours` even though the transfer table covers only
  the most recent 600 blocks.
- `minPros` is a value term, not a share term: native has no supply to divide by.
  A native transfer below `minPros` PROS is dropped from `watch.native`; the
  default `"0"` reports every native movement touching a watched address.
- Native tracking is **additive and fail-soft**. A native read that fails reports
  `scan.native.partial: true` and its gaps, but never invalidates the ERC-20
  findings. The ERC-20 failure contract (`SCAN_UNAVAILABLE`) is unchanged.
- Native has no token contract and no supply, so `watch.native` entries carry
  `token.address: null` and `token.totalSupply: null`, and no `sharePercent`.
  `watch.summary` gains `nativeIn`, `nativeOut`, `nativeBalance`,
  `nativeBalanceWei`, `nativeDelta` (signed, `+` prefixed) and `nativeDeltaWei`.

## Limits

- `maxHours: 6`, `maxChunks: 6` — a scan never exceeds 6000 blocks regardless of
  block time. A window wider than that is **capped**, not rejected, and the
  response says so in three numbers instead of one: `blocksRequested` (what the
  caller asked for), `windowBlocks` (what the caps allowed) and `blocksScanned`
  (what was actually read). On this chain with 1.1s blocks, `hours=6` is a request
  for 19,000+ blocks that the cap answers with 6000 — about 110 minutes. So a
  capped response carries `capTruncatedBlocks`, `windowSecondsCovered` and
  `windowCoverageBps`, because `blocksCapped: true` alone did not tell a reader
  that "6 hours" was really "1.8 hours".
- No pagination across windows: one request covers one window.
- `SELF` transfers are ranked, since moving 1% of supply to yourself is still a
  movement worth seeing.

## Running

```
npm test              # 70 unit + 20 API, offline, no network
npm run test:live     # 14 tests against rpc.pharos.xyz
npm run verify:chain  # independent recomputation, 16 checks
npm run dev           # wrangler pages dev on :8781
```

`npm test` uses an in-memory fake chain that answers the same JSON-RPC methods and
can be told to fail specific chunks, so the failure paths above are exercised
offline. No dependencies, no `node_modules`, compatible with `workerd`.

`scripts/verify-chain.mjs` deliberately does not import from `src/`: it re-derives
the same numbers from raw RPC responses with its own decoding and compares. If a
bug lives in `src/`, that script cannot inherit it.

## Layout

```
src/keccak.mjs      Keccak-256 (0x01 domain, not SHA3's 0x06)
src/hex.mjs         quantities, ABI words, address topics
src/numbers.mjs     exact integer formatting, no floats
src/address.mjs     EIP-55 checksum, no silent normalisation
src/rpc.mjs         JSON-RPC with rate-limit backoff
src/logs.mjs        chunk planning and range scanning
src/tokens.mjs      symbol/decimals/totalSupply, cached per scan
src/whales.mjs      Transfer log decoding and finding construction
src/native.mjs      native PROS block-body decoding and batching
src/share.mjs       basis-point ranking and percent display
src/scan.mjs        orchestration and validation
functions/api/whales.js   GET handler
public/            dashboard, renders only what the API returned
test/              harness with fake chain, unit, api, live
scripts/verify-chain.mjs  independent audit against the live chain
```

The dashboard computes nothing: no arithmetic, no formatting from raw units, no
thresholding, no verdict. If the API says 0.8653%, the page prints 0.8653. There
is no code path that can invent a row.
