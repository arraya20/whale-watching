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

| parameter     | meaning                              | bounds                  |
| ------------- | ------------------------------------ | ----------------------- |
| `hours`       | how far back to scan                 | 0.05 – 6, up to 2 dp    |
| `minShareBps` | minimum share of supply, in bps      | integer 0 – 10000       |
| `limit`       | maximum findings returned            | integer 1 – 100         |
| `watch`       | address to watch (repeatable)        | max 20, EIP-55 required |

The caller supplies **intent only**. Supplying a fact — `from`, `to`, `amountWei`,
`decimals`, `totalSupply`, `verdict`, `watchedAddresses` and similar names — is
refused with `400 CALLER_SUPPLIED_FACTS` rather than ignored, because an ignored
fact still leaves the caller believing it was applied.

### Response

```jsonc
{
  "ok": true,
  "scan": {
    "chainId": 1672,
    "headBlock": 22156107,
    "fromBlock": 22152891,
    "blocksRequested": 3217,
    "blocksScanned": 3217,
    "blocksCapped": false,
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
      "to": "0x75E54ACb9107Cc35969b44Eb6342F50686b3A12d",
      "amountRaw": "528479988729089059",
      "amount": "0.528479",
      "amountExact": "0.528479988729089059",
      "shareBpsRaw": "86",
      "shareBps": 86,
      "sharePercent": "0.8653",
      "blockNumber": 22154961,
      "logIndex": 12,
      "txHash": "0x…"
    }
  ],
  "watch": { "addresses": ["0x…"], "activity": [] },
  "skipped": [{ "reason": "AMOUNT_DATA_NOT_ONE_WORD", "count": 3 }],
  "limits": { "maxHours": 6, "maxChunks": 6, "maxLimit": 100, "maxWatch": 20 }
}
```

`kind` is `TRANSFER`, `MINT` (from the zero address), `BURN` (to it) or `SELF`.

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
| token does not answer `decimals()`     | token skipped as `DECIMALS_UNREADABLE`     |
| log amount is not exactly one word     | skipped as `AMOUNT_DATA_NOT_ONE_WORD`      |
| log is marked `removed` (reorg)        | skipped as `REORGED`                       |
| log has more than 3 topics             | skipped as `NONSTANDARD_TOPICS`            |
| address topic has dirty padding        | skipped as `TOPIC_DIRTY_PADDING`           |

A skipped transfer is counted with its reason and left out of the ranking. It is
never shown with a guessed amount, symbol or decimals.

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

## Limits

- `maxHours: 6`, `maxChunks: 6` — a scan never exceeds 6000 blocks regardless of
  block time. A window wider than that is **capped** and reported as
  `blocksCapped: true`, not rejected.
- No pagination across windows: one request covers one window.
- `SELF` transfers are ranked, since moving 1% of supply to yourself is still a
  movement worth seeing.

## Running

```
npm test              # 53 unit + 16 API, offline, no network
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
