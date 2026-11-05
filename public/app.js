// Dashboard controller.
//
// Deliberately dumb: it renders what the API returned and computes nothing.
// No share arithmetic, no amount formatting from raw units, no thresholding, no
// "whale" verdict. The one number it derives is nothing at all — that is the
// rule. If the API says a transfer is 4.01% of supply, the page prints 4.01.
//
// The scaffold this replaces had a "simulate" button that fabricated a transfer
// in the browser and fed it back to a predicate, then displayed the result as a
// detection. That button is not here, and there is no code path that can invent
// a row: every row in the table originated as an `eth_getLogs` result.

const $ = (id) => document.getElementById(id);

const form = $("controls");
const go = $("go");
const status = $("status");
const meta = $("meta");
const gap = $("gap");
const results = $("results");
const rows = $("rows");
const watchSection = $("watchSection");
const watchRows = $("watchRows");
const skipped = $("skipped");
const skippedList = $("skippedList");

const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

let inFlight = null;

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

function clearSections() {
  meta.hidden = true;
  gap.hidden = true;
  results.hidden = true;
  watchSection.hidden = true;
  skipped.hidden = true;
  rows.replaceChildren();
  watchRows.replaceChildren();
  skippedList.replaceChildren();
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function kindCell(kind) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `kind ${kind.toLowerCase()}`;
  span.textContent = kind;
  td.appendChild(span);
  return td;
}

function renderRow(f, withDirection) {
  const tr = document.createElement("tr");
  if (withDirection) tr.appendChild(cell(f.direction, "mono"));

  // sharePercent arrives as an exact decimal string from integer arithmetic
  // server-side. Printing it is the whole job.
  tr.appendChild(cell(`${f.sharePercent}%`, "share"));
  tr.appendChild(cell(f.token.symbol, "mono"));
  tr.appendChild(cell(f.amount, "num"));
  tr.appendChild(kindCell(f.kind));
  tr.appendChild(cell(short(f.from), "addr"));
  tr.appendChild(cell(short(f.to), "addr"));
  tr.appendChild(cell(String(f.blockNumber), "mono"));
  return tr;
}

function renderMeta(s, limits) {
  const lines = [
    ["window", `blocks ${s.fromBlock}–${s.toBlock} (${s.blocksScanned.toLocaleString()} scanned of ${s.blocksRequested.toLocaleString()} requested)`],
    ["head block", s.headBlock.toLocaleString()],
    ["block time", `${s.blockTimeSeconds}s`],
    ["chunks", `${s.chunksRead} of ${s.chunksPlanned} read`],
    ["transfers", `${s.transfersDecoded} decoded of ${s.transfersRead} read, ${s.transfersRanked} rankable`],
    ["tokens", String(s.tokensSeen)],
    ["took", `${s.durationMs} ms`],
  ];
  meta.replaceChildren();
  for (const [k, v] of lines) {
    const div = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = v;
    div.append(`${k}: `, b);
    meta.appendChild(div);
  }
  if (s.blocksCapped) {
    const div = document.createElement("div");
    div.textContent = `window capped at the ${limits.maxChunks * 1000} block limit`;
    meta.appendChild(div);
  }
  meta.hidden = false;
}

function renderGap(s) {
  if (!s.partial) {
    gap.hidden = true;
    return;
  }
  gap.replaceChildren();
  gap.append(
    `Partial scan: ${s.failedChunkCount} of ${s.chunksPlanned} block ranges could not be read. ` +
      `Results cover the rest only — an empty list here does not mean nothing happened. `,
  );
  const code = document.createElement("code");
  code.textContent = s.failedChunks.map((c) => `${c.fromBlock}–${c.toBlock}`).join(", ");
  gap.append("Gaps: ", code);
  gap.hidden = false;
}

function renderSkipped(list) {
  if (!list.length) {
    skipped.hidden = true;
    return;
  }
  skippedList.replaceChildren();
  for (const entry of list) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = entry.reason;
    li.append(code, ` × ${entry.count}`);
    skippedList.appendChild(li);
  }
  skipped.hidden = false;
}

function render(data) {
  clearSections();
  const s = data.scan;
  renderMeta(s, data.limits);
  renderGap(s);

  if (data.findings.length === 0) {
    // Distinct from an error, and distinct from a partial scan: the chain was
    // read, and this window genuinely had nothing above the threshold.
    results.hidden = false;
    rows.replaceChildren();
    const tr = document.createElement("tr");
    const td = cell(
      s.partial
        ? "No transfers above the threshold in the ranges that were read."
        : "No transfers above the threshold in this window.",
      "empty",
    );
    td.colSpan = 7;
    tr.appendChild(td);
    rows.appendChild(tr);
  } else {
    results.hidden = false;
    for (const f of data.findings) rows.appendChild(renderRow(f, false));
  }

  if (data.watch.addresses.length > 0) {
    watchSection.hidden = false;
    if (data.watch.activity.length === 0) {
      const tr = document.createElement("tr");
      const td = cell("No activity for the watched addresses in this window.", "empty");
      td.colSpan = 8;
      tr.appendChild(td);
      watchRows.appendChild(tr);
    } else {
      for (const f of data.watch.activity) watchRows.appendChild(renderRow(f, true));
    }
  }

  renderSkipped(data.skipped);

  const parts = [`${data.findings.length} transfer${data.findings.length === 1 ? "" : "s"} above`];
  parts.push(`${data.threshold.minShareBps} bps`);
  if (s.partial) parts.push(`partial: ${s.failedChunkCount} range(s) unread`);
  setStatus(parts.join(" · "), s.partial ? "" : "");
}

function renderError(payload, httpStatus) {
  clearSections();
  const code = payload?.code ?? `HTTP_${httpStatus}`;
  const message = payload?.error ?? "the request failed";
  setStatus(`${code}: ${message}`, "bad");
}

async function run() {
  const data = new FormData(form);
  const params = new URLSearchParams();
  params.set("hours", data.get("hours"));
  params.set("minShareBps", data.get("minShareBps"));
  params.set("limit", data.get("limit"));

  const watch = String(data.get("watch") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  for (const address of watch) params.append("watch", address);

  // One request at a time. The scaffold let concurrent responses race, so a slow
  // earlier scan could overwrite a newer one and the page showed stale rows as
  // current.
  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;

  go.disabled = true;
  setStatus("scanning", "busy");

  try {
    const res = await fetch(`/api/whales?${params}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (inFlight !== controller) return;
    if (!res.ok || !payload?.ok) {
      renderError(payload, res.status);
      return;
    }
    render(payload);
  } catch (e) {
    if (e.name === "AbortError") return;
    if (inFlight !== controller) return;
    setStatus(`could not reach the API: ${e.message}`, "bad");
    clearSections();
  } finally {
    if (inFlight === controller) {
      inFlight = null;
      go.disabled = false;
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});

run();
