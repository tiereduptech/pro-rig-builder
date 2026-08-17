// The rules that can condemn a catalog row, tested without an SFTP endpoint.
//
// WHY THIS TEST EXISTS
//   1,725 of the 2,666 Newegg rows have no other priced retailer, so a wrong
//   "dead" verdict here deletes the only buy link a product has. Two things
//   protect against that and both are one boolean away from being useless:
//     - two strikes before any death verdict
//     - a strike may only advance on a DIFFERENT feed snapshot, because
//       re-reading the same file twice is one observation, not a confirmation
//   The second is the subtle one. A dispatch-twice-in-five-minutes habit would
//   otherwise manufacture a second strike against a byte-identical feed and
//   condemn every sku that a single bad pull happened to miss.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const audit = require("../newegg-dead-sku-audit.cjs");

const { classifySighting, strikeVerdict, FULL_CATALOG_RE } = audit;

test("a sku listed in-stock is alive", () => {
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "0" }), "alive");
  assert.equal(classifySighting({ availability: "In-Stock" }), "alive");
  assert.equal(classifySighting({ availability: "instock" }), "alive");
});

test("listed but not in stock is unbuyable, never dead", () => {
  for (const availability of ["out-of-stock", "backordered", "", "unavailable"]) {
    assert.equal(classifySighting({ availability }), "unbuyable",
      `availability=${JSON.stringify(availability)} must read as unbuyable`);
  }
});

test("is_deleted overrides any availability string", () => {
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "1" }), "deleted");
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "true" }), "deleted");
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "deleted" }), "deleted");
  // Anything else is not a deletion flag — "0", "", "no" must not condemn.
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "0" }), "alive");
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "" }), "alive");
});

test("one strike is pending, never dead", () => {
  const v = strikeVerdict({ gone: true, prevN: 0, sameSnapshot: false });
  assert.equal(v.n, 1);
  assert.equal(v.verdict, "pending");
});

test("two strikes across different snapshots confirm dead", () => {
  const v = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: false });
  assert.equal(v.n, 2);
  assert.equal(v.verdict, "dead");
});

test("a second read of the SAME feed snapshot cannot advance a strike", () => {
  const v = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: true });
  assert.equal(v.n, 1, "strike must be held at one against an identical feed");
  assert.equal(v.verdict, "pending");
  // And a first-ever sighting on a repeat snapshot still only earns one strike.
  assert.equal(strikeVerdict({ gone: true, prevN: 0, sameSnapshot: true }).n, 1);
});

test("a sku that is present earns no strike at all", () => {
  assert.deepEqual(strikeVerdict({ gone: false, prevN: 1 }), { n: 0, verdict: null });
});

test("only full product catalogs are accepted as absence evidence", () => {
  assert.ok(FULL_CATALOG_RE.test("44583_4681679_mp.txt.gz"));
  assert.ok(FULL_CATALOG_RE.test("44583_4681679_mp_MKPL.txt.gz"));
  // A delta feed carries CHANGES; absence from one means nothing. Feeding
  // deltas to an absence test would condemn the whole catalog on run one.
  assert.equal(FULL_CATALOG_RE.test("44583_4681679_mp_delta.txt.gz"), false);
  assert.equal(FULL_CATALOG_RE.test("44583_4681679_mp_delta_MKPL.txt.gz"), false);
  assert.equal(FULL_CATALOG_RE.test("44583_4681679_mp_template.txt.gz"), false);
});
