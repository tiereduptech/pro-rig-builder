// Proves keyboardAttributes() reads only what a title states, and stays quiet
// otherwise. The three fields here were measured against the 56 keyboard rows
// that already carry them — wireless 44/44, rgb 38/38, layout 40/41 — before
// any of this was allowed to write to the catalog.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { keyboardAttributes, extractSpecs } = require('../catalog-classify.cjs');

test('keyboard: connection — positive wireless evidence wins over "wired"', () => {
  // Tri-mode boards say both words; the wireless claim is the one that matters.
  assert.strictEqual(keyboardAttributes('F99 Wireless Mechanical Keyboard, Tri-Mode BT5.0/2.4GHz/USB Wired').wireless, true);
  assert.strictEqual(keyboardAttributes('Keychron K8 Pro Bluetooth Mechanical Keyboard').wireless, true);
  assert.strictEqual(keyboardAttributes('Redragon K552 Wired Mechanical Gaming Keyboard').wireless, false);
});

test('keyboard: a title that says neither leaves connection unknown', () => {
  assert.strictEqual('wireless' in keyboardAttributes('Logitech G413 SE Mechanical Gaming Keyboard - Backlit'), false);
});

test('keyboard: backlight is only ever a positive claim', () => {
  assert.strictEqual(keyboardAttributes('Redragon K556 RGB LED Backlit Mechanical Keyboard').rgb, true);
  // No mention of a backlight is not a claim that there is none.
  assert.strictEqual('rgb' in keyboardAttributes('Generic Office Keyboard 104 Key'), false);
});

test('keyboard: layout reads the most specific claim, not the loosest', () => {
  const cases = [
    ['Redragon K552 TKL 87 Key Mechanical Keyboard', 'TKL'],
    ['Glorious GMMK 2 Prebuilt 96% Full Size Wired Mechanical', '96%'],
    ['Keychron K8 Pro 75% Layout Wireless Keyboard', '75%'],
    ['Royal Kludge RK68 65% 68 Key Hot-Swappable', '65%'],
    ['Ducky One 3 Mini 60% RGB Mechanical Keyboard', '60%'],
    ['Logitech G413 SE Full-Size Mechanical Gaming Keyboard', 'Full-Size'],
    ['Corsair K70 RGB PRO 104 Key Mechanical Keyboard', 'Full-Size'],
  ];
  for (const [title, want] of cases) assert.strictEqual(keyboardAttributes(title).layout, want, title);
});

// A 96% board is routinely marketed as "full size". Reading the stated
// percentage is the whole reason the layout ladder is ordered as it is.
test('keyboard: a percentage beats the words "full size" in the same title', () => {
  assert.strictEqual(keyboardAttributes('96% Full Size Compact Keyboard').layout, '96%');
});

// The field conflates switch technology with switch feel, so nothing may write
// to it until it is split. This test is the guard on that decision.
test('keyboard: switches is never extracted, because the field means two things', () => {
  for (const title of [
    'Redragon K552 Mechanical Gaming Keyboard Cherry MX Red Linear Switches',
    'Logitech G413 SE Full-Size Mechanical Gaming Keyboard Tactile',
    'Razer Huntsman Optical Switch Gaming Keyboard Clicky',
  ]) {
    const out = keyboardAttributes(title);
    assert.strictEqual('switches' in out, false, title);
    assert.strictEqual('kbType' in out, false, title);
  }
});

test('keyboard: extractSpecs routes Keyboard titles through the helper', () => {
  assert.deepStrictEqual(
    extractSpecs('Keychron K8 Pro Wireless Bluetooth 75% RGB Backlit Keyboard', 'Keyboard'),
    { wireless: true, rgb: true, layout: '75%' },
  );
  // Nothing stated, nothing invented.
  assert.deepStrictEqual(extractSpecs('Keyboard', 'Keyboard'), {});
});
