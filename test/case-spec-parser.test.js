// The case spec parser must never read a number that belongs to a different
// product, or to a different label.
//
// Every fixture below is the real shape from a live Amazon listing that the old
// blob-regex parser got wrong, and each wrong value reached the site before #36
// removed it. The failures are cheap to reintroduce — the whole class comes back
// the moment someone flattens these sources into one string again — and a
// re-run of the enrichment refills any field that is null, so a correction made
// by hand does not survive a parser that still makes the mistake.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecs, splitUnits, sizesIn } from '../scripts/case-spec-parser.mjs';

const listing = ({ title = '', description = '', body = {}, aplus = [] }) => ({
  title,
  description,
  product_information: [
    { body },
    { contents: [{ rows: aplus.map(text => ({ text })) }] },
  ],
});

test('a comparison-table row is refused — its columns are other products', () => {
  // B0GDXM372W: a $99.99 case whose A+ table's first column is a $74.99 one.
  // The old parser published 420mm / 178mm / 6 fans off that column.
  const item = listing({
    title: 'MUSETEX ATX PC Case with 7 Pre-Installed PWM ARGB Fans',
    aplus: [
      'Max GPU Length   420mm(16.54")   410mm (16.14")   400mm(15.75")   320mm (12.59")\n' +
      'Max CPU Cooler Height   178mm(7")   176mm (6.93")   160mm(6.3")   176mm (6.93")\n' +
      'Number Of Fans Pre-installed   6 PWM ARGB Fans   5 PWM ARGB Fans   3 Non-LED Fans   6 PWM ARGB Fans',
    ],
  });
  const specs = parseSpecs(item);
  assert.equal(specs.maxGPU, undefined, 'took a GPU length off a comparison column');
  assert.equal(specs.maxCooler, undefined, 'took a cooler height off a comparison column');
  assert.equal(specs.fans_inc, 7, "read the table's 6 instead of the title's 7");
});

test('a two-column spec row IS this product, and is read', () => {
  const specs = parseSpecs(listing({ aplus: ['Max GPU Length   410mm\nMax CPU Cooler Height   170mm'] }));
  assert.equal(specs.maxGPU, 410);
  assert.equal(specs.maxCooler, 170);
});

test('a value does not bind backwards to the NEXT label across a line', () => {
  // B0CGFTBVCD: "Rear: 1x 120mm" then "Radiator Support" on the next line. The
  // old parser matched /120mm\s*Radiator/ across the join and published 120mm
  // radiator support for a case that takes 360mm.
  const item = listing({
    aplus: [
      'Fan Support        Top: 3x 120mm / 2x 140mm - Rear: 1x 120mm\n' +
      'Radiator Support   Top: 240mm / 280mm / 360mm - Side: 240mm / 280mm / 360mm - Rear: 120mm',
    ],
  });
  assert.deepEqual(parseSpecs(item).rads, [120, 240, 280, 360]);
});

test('a clearance range yields its upper bound, not its floor', () => {
  // B0D7BNK6CB: the cell reads "280mm - 415mm". The old parser took 280 and told
  // shoppers a 415mm case fits nothing bigger than a 280mm card.
  assert.equal(parseSpecs(listing({ aplus: ['Max GPU Length   280mm - 415mm'] })).maxGPU, 415);
  assert.equal(parseSpecs(listing({ description: 'Front fan supports GPUs up to 415mm, rear fan up to 390mm.' })).maxGPU, 415);
});

test('the number after a spec name stops at , / & +', () => {
  // "Supports 320mm GPU & 240mm Radiator" is a 320mm card clearance. A bridge
  // that steps over the ampersand reads the radiator size as the card's.
  assert.equal(parseSpecs(listing({ title: 'RAIDMAX X921, Supports 320mm GPU & 240mm Radiator' })).maxGPU, 320);
  assert.equal(parseSpecs(listing({ title: 'GAMDIAS, 360mm AIO/Radiator, 340mm GPU/VGA, 160mm CPU Cooler' })).maxGPU, 340);
  assert.equal(parseSpecs(listing({ title: 'ASUS ROG Strix Helios, GPU Braces, 420mm Radiator Support' })).maxGPU, undefined);
});

test('embedded newlines in one field still separate one label from the next', () => {
  // B07T4W3BMH packs the description one spec per line. Left whole, the parser
  // read the COOLER height as the card clearance.
  const specs = parseSpecs(listing({
    description: 'CPU Cooler Max Height: 160mm\nVGA Card Max Length: 370mm',
  }));
  assert.equal(specs.maxGPU, 370);
  assert.equal(specs.maxCooler, 160);
});

test('a count-prefixed size is a fan, never a radiator or a clearance', () => {
  const specs = parseSpecs(listing({
    title: 'Okinos Walnut Case, Support 360mm Radiator on Top, Pre-Installed 4 x 120mm PWM Fans',
  }));
  assert.deepEqual(specs.rads, [360], '120mm fans were counted as radiator support');
  assert.deepEqual(sizesIn('3x 120mm / 2 x 140mm'), []);
  assert.deepEqual(sizesIn('Top: 240mm / 360mm'), [240, 360]);
});

test('a liquid-cooling size is not a CPU cooler height', () => {
  // 240 clears the height bound, so a head of merely /cool/ would land it.
  assert.equal(parseSpecs(listing({ title: 'Case with liquid cooling up to 240mm' })).maxCooler, undefined);
  assert.equal(parseSpecs(listing({ title: 'Case supporting CPU coolers up to 165 mm in height' })).maxCooler, 165);
});

test('rads comes out as integers, so the App.jsx filter can read it', () => {
  const rads = parseSpecs(listing({ title: 'ATX Case, 360mm Radiator Support' })).rads;
  assert.ok(Array.isArray(rads), 'rads must be an array — the filter buckets every other shape as "None"');
  assert.ok(rads.every(Number.isInteger));
});

test('splitUnits keeps three-or-more-cell lines out of the unit list', () => {
  const { units } = splitUnits(listing({ aplus: ['Label   a   b   c\nLabel2   only-value'] }));
  assert.deepEqual(units.map(u => u.label ?? u.text), ['Label2']);
});
