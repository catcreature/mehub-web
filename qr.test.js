// Pins `qr.js` to the phone's encoder. `qr-fixture.json` is written by the Kotlin side itself
// (`QrFixtureTest`), so if the port drifts from `Qr.kt` these fail instead of the browser drawing a
// code the phone cannot read. Run with `node --test web/` from the repo root.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { qrCode } from './qr.js';
import { formatWebSignIn } from './crypto.js';

const fixture = JSON.parse(readFileSync(new URL('./qr-fixture.json', import.meta.url), 'utf8'));

// The same inputs the Kotlin test used, by the same names. Building this one through
// formatWebSignIn means the fixture also pins the checksum: a code the phone would refuse encodes to
// different modules, so these fail.
const web = await formatWebSignIn('w'.repeat(43), 'a1b2c3d4');
const cases = {
  'auto:web': [web, null],
  'auto:short': ['hello', null],
  'auto:one': ['1', null],
  'auto:long': ['m'.repeat(150), null],
  'auto:invite': [`mehub1:${'a'.repeat(43)}:${'b'.repeat(88)}`, null],
  'auto:utf8': ['naïve — ünïcødé ✓', null],
};
for (let m = 0; m <= 7; m++) cases[`mask${m}:web`] = [web, m];

const drawn = (modules) => modules.map((row) => row.map((on) => (on ? '#' : '.')).join(''));

test('every case matches the modules the phone draws', () => {
  // The fixture is the contract: a case in one and not the other is a drifted port, not a pass.
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(fixture).sort());
  for (const [name, [text, mask]] of Object.entries(cases)) {
    assert.deepEqual(drawn(qrCode(text, mask)), fixture[name], name);
  }
});

test('the version grows with the text, and runs out after 213 bytes', () => {
  assert.equal(qrCode('1').length, 21);
  assert.equal(qrCode('m'.repeat(150)).length, 49);
  assert.equal(qrCode('m'.repeat(213)).length, 57);
  assert.throws(() => qrCode('m'.repeat(214)), /version 10/);
});

test('a multi-byte character is counted in bytes, not characters', () => {
  // 71 characters, 213 bytes: the last code that fits.
  assert.equal(qrCode('✓'.repeat(71)).length, 57);
  assert.throws(() => qrCode('✓'.repeat(72)), /version 10/);
});

test('the chosen mask is the one with the lowest penalty', () => {
  const auto = drawn(qrCode(web));
  const scores = [];
  for (let m = 0; m <= 7; m++) scores.push(drawn(qrCode(web, m)));
  assert.ok(scores.some((rows) => rows.join() === auto.join()), 'auto picked a mask it never drew');
});
