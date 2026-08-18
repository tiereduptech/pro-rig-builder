// Proves the SFTP feed parser streams instead of buffering, and that the
// backpressure path works.
//
// WHY THIS TEST EXISTS
//   sftp-ingest.yml succeeded twice in 99 runs between 2026-05-14 and
//   2026-08-17. The parser accumulated every record into one array and resolved
//   with it, so the 886MB _MKPL marketplace feed died with "Ineffective
//   mark-compacts near heap limit" at 6,135MB of the 6,144MB cap. 88 runs were
//   cancelled at the 60-minute timeout while GC-thrashing, 9 were killed
//   outright. The commit step is skipped on both, so the daily Newegg feed wrote
//   nothing to the catalog for 95 days and nothing noticed.
//
//   The memory assertion below is the one that matters. It is written as a PEAK
//   sampled during the stream, not a delta measured afterwards, because a
//   buffered array is freed the moment the promise resolves — measuring at the
//   end would pass against exactly the bug this is guarding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ingest = require("../sftp-ingest.cjs");

const { streamTxtFeed, DEFAULT_FIELD_ORDER } = ingest;

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sftpfeed-")); });
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;

/** One pipe-delimited feed row with 38 fields. */
function row(i, over = {}) {
  const f = DEFAULT_FIELD_ORDER.map((name) => {
    if (name in over) return over[name];
    if (name === "sku") return `SKU${i}`;
    if (name === "product_name") return `Product ${i}`;
    if (name === "upc") return String(800000000000 + i);
    if (name === "sale_price") return "199.99";
    if (name === "retail_price") return "249.99";
    if (name === "availability") return "in-stock";
    if (name === "is_deleted") return "0";
    return `v${name}`;
  });
  return f.join("|");
}

/** Gzip a feed with HDR + n rows + TRL and return its path. */
function feedFixture(n, { rowFn = row, mid = "44583" } = {}) {
  const lines = [`HDR|${mid}|Newegg|2026-08-17T12:00:00Z`];
  for (let i = 0; i < n; i++) lines.push(rowFn(i));
  lines.push(`TRL|${n}`);
  const p = path.join(tmp, `feed-${seq++}.txt.gz`);
  fs.writeFileSync(p, zlib.gzipSync(lines.join("\n") + "\n"));
  return p;
}

// ── correctness ─────────────────────────────────────────────────────────────

test("streams every data row, skipping HDR and TRL", async () => {
  const seen = [];
  const r = await streamTxtFeed(feedFixture(5), (rec) => seen.push(rec));
  assert.equal(seen.length, 5);
  assert.equal(r.recordCount, 5, "recordCount counts data rows only");
  assert.equal(r.trailerCount, 5, "TRL is parsed, not treated as a record");
  assert.equal(r.header.length, 38);
  assert.equal(r.lineNum, 7, "lineNum counts every physical line incl. HDR/TRL");
});

test("fields map to their documented positions", async () => {
  const seen = [];
  await streamTxtFeed(feedFixture(1), (rec) => seen.push(rec));
  const rec = seen[0];
  assert.equal(rec.sku, "SKU0");
  assert.equal(rec.product_name, "Product 0");
  assert.equal(rec.upc, "800000000000");
  assert.equal(rec.sale_price, "199.99");
  assert.equal(rec.availability, "in-stock");
  assert.equal(Object.keys(rec).length, 38);
});

test("values are trimmed and short rows yield empty strings, not undefined", async () => {
  const p = path.join(tmp, `short-${seq++}.txt.gz`);
  fs.writeFileSync(p, zlib.gzipSync("HDR|44583|Newegg|t\n  SKU9  |  Padded Name  |third\nTRL|1\n"));
  const seen = [];
  await streamTxtFeed(p, (rec) => seen.push(rec));
  assert.equal(seen[0].sku, "SKU9", "leading/trailing space stripped");
  assert.equal(seen[0].product_name, "Padded Name");
  assert.equal(seen[0].upc, "", "missing trailing field is '' not undefined");
});

test("blank lines are skipped without producing records", async () => {
  const p = path.join(tmp, `blank-${seq++}.txt.gz`);
  fs.writeFileSync(p, zlib.gzipSync(`HDR|44583|Newegg|t\n${row(1)}\n\n\n${row(2)}\nTRL|2\n`));
  const r = await streamTxtFeed(p, () => {});
  assert.equal(r.recordCount, 2);
});

test("a trailer count that disagrees with the rows parsed is reported, not hidden", async () => {
  const p = path.join(tmp, `mismatch-${seq++}.txt.gz`);
  fs.writeFileSync(p, zlib.gzipSync(`HDR|44583|Newegg|t\n${row(1)}\nTRL|99\n`));
  const r = await streamTxtFeed(p, () => {});
  assert.equal(r.recordCount, 1);
  assert.equal(r.trailerCount, 99, "caller compares these and logs the disagreement");
});

// ── the memory guarantee ────────────────────────────────────────────────────

test("peak heap stays flat across a large feed — no record array", async () => {
  const N = 300_000;
  const p = feedFixture(N);

  // Sample DURING the stream. A buffered implementation frees its array on
  // resolve, so an after-the-fact delta would pass against the very bug this
  // test exists to catch.
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  let count = 0;

  const r = await streamTxtFeed(p, () => {
    count++;
    if (count % 10_000 === 0) {
      const h = process.memoryUsage().heapUsed;
      if (h > peak) peak = h;
    }
  });

  assert.equal(r.recordCount, N, "every record reached the callback");
  assert.equal(count, N);

  const growthMB = (peak - baseline) / 1024 / 1024;
  // 300k retained 38-field records is >500MB. Streaming holds one record, so
  // real growth is a few MB of transient garbage. 200MB is far above the
  // streaming cost and far below the buffered cost — it discriminates without
  // being flaky about GC timing.
  assert.ok(
    growthMB < 200,
    `peak heap grew ${growthMB.toFixed(1)}MB across ${N} records — the parser is retaining them again`
  );
});

// ── backpressure ────────────────────────────────────────────────────────────

test("ctl.backpressure pauses the feed and every record still arrives", async () => {
  const N = 20_000;
  const p = feedFixture(N);
  const outPath = path.join(tmp, `out-${seq++}.jsonl`);
  // A deliberately tiny highWaterMark so write() returns false constantly and the
  // pause/resume path is exercised thousands of times rather than never.
  const out = fs.createWriteStream(outPath, { encoding: "utf8", highWaterMark: 256 });

  let pauses = 0;
  const r = await streamTxtFeed(p, (rec, ctl) => {
    if (!out.write(JSON.stringify({ sku: rec.sku }) + "\n")) {
      pauses++;
      ctl.backpressure(out);
    }
  });
  out.end();
  await new Promise((res) => out.on("finish", res));

  assert.equal(r.recordCount, N);
  assert.ok(pauses > 0, "the tiny highWaterMark must have triggered backpressure");
  const written = fs.readFileSync(outPath, "utf8").trim().split("\n");
  assert.equal(written.length, N, "no records lost across pause/resume");
  assert.equal(JSON.parse(written[0]).sku, "SKU0");
  assert.equal(JSON.parse(written[N - 1]).sku, `SKU${N - 1}`);
});

test("repeated backpressure calls while paused do not leak drain listeners", async () => {
  const p = feedFixture(5_000);
  const out = fs.createWriteStream(path.join(tmp, `out-${seq++}.jsonl`), { highWaterMark: 256 });
  let maxListeners = 0;
  await streamTxtFeed(p, (rec, ctl) => {
    out.write(JSON.stringify(rec.sku) + "\n");
    // Call it unconditionally — the guard inside must collapse these.
    ctl.backpressure(out);
    ctl.backpressure(out);
    maxListeners = Math.max(maxListeners, out.listenerCount("drain"));
  });
  out.end();
  assert.ok(maxListeners <= 1, `drain listeners peaked at ${maxListeners}, expected <= 1`);
});

// ── failure handling ────────────────────────────────────────────────────────

test("a throwing callback rejects instead of hanging or being swallowed", async () => {
  const p = feedFixture(1_000);
  await assert.rejects(
    () => streamTxtFeed(p, (rec) => { if (rec.sku === "SKU10") throw new Error("boom"); }),
    /boom/
  );
});

test("a corrupt gzip rejects", async () => {
  const p = path.join(tmp, `corrupt-${seq++}.txt.gz`);
  fs.writeFileSync(p, Buffer.from("this is not gzip data at all"));
  await assert.rejects(() => streamTxtFeed(p, () => {}));
});

test("importing the module does not run the CLI", () => {
  // The CLI body is gated on require.main. If that regressed, importing this
  // file would try to reach aftp.linksynergy.com during `npm test`.
  assert.equal(typeof ingest.streamTxtFeed, "function");
  assert.equal(typeof ingest.matchRecord, "function");
  assert.equal(typeof ingest.buildCatalogIndex, "function");
});
