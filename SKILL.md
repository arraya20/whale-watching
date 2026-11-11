---
name: pharos-whale-watcher
description: Scan Pharos for large token movements ranked by share of supply, not by a wei threshold.
version: 1.0.0
---

# Pharos Whale Watcher

## Safety boundary

Read-only scan. No signing, no keys, no execution.

## Input

Query parameters, intent only:

- `hours` — window, at most 6, one or two decimal places;
- `threshold` — `minShareBps`, the size that counts as large, as basis points of
  total supply (`0..10000`);
- `limit` — rows, `1..100`;
- `watch` — optional allowlisted addresses to highlight, at most 20 (defaults to 5 canonical/active Pharos addresses when omitted).

Transfers, amounts, balances, token metadata, verdicts and `watchedAddresses`
supplied by the caller are refused. The scaffold this replaced accepted `from`,
`to`, `amountWei` and the watchlist from the requester, so the caller defined
what a whale was and the "detection" was arithmetic over the caller's own claim.
A tracker that believes its requester is not a tracker.

## Procedure

1. Validate parameters. Reject `1e3`, ` 1`, `0x10`, `1.2.3` — a parameter parser
   that coerces is a parser deciding what the caller meant.
2. Measure block time from the chain. Window sizing in hours depends on it, and
   an assumed value silently scans the wrong span.
3. Chunk the window, bounded to 6000 blocks (`maxChunks`), and read transfer logs.
4. Resolve each token's decimals and total supply from the chain.
5. Rank by share of supply in basis points, not by an absolute wei amount.
   Decimals differ per asset — USDC is 6, WPROS 18 — so a wei threshold ranks
   assets by their scale rather than by the size of the movement.
6. Return the largest movements with block, token, exact base-unit
   amount, share of supply, labelled counterparties (`fromLabel`, `toLabel`),
   human-readable `explanation`, and a per-address `watch.summary` across all
   watched addresses.

## Output requirement

Include the measured block time, the window actually scanned, the requested
threshold, and the scan limits. Amounts stay exact integers with their decimals.

Status codes: `400` for `BAD_HOURS`, `BAD_THRESHOLD`, `BAD_LIMIT`, `BAD_WATCH`,
`BAD_WATCH_ADDRESS`; `409` for `WRONG_CHAIN`; `502` for `RPC_UNAVAILABLE`,
`BLOCK_TIME_UNAVAILABLE`, `SCAN_UNAVAILABLE`, `METADATA_UNAVAILABLE` — an unreadable
chain is not a finding of "nothing happened".

Report the window you actually covered, not the one that was requested: a capped or
partial scan returns `blocksRequested`, `windowBlocks`, `blocksScanned`,
`windowSecondsCovered` and `windowCoverageBps`. If `degraded` is true, say that the
ranking covers only the transfers whose token supply could be read
(`transfersUnranked` says how many were dropped and why: `metadataUnavailable` for
throttled reads, `metadataInvalid` for contracts that answered nothing).
