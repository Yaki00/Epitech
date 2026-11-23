'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConsignes, sameAsExample } = require('../src/reading/consignes');

describe('consignes de lecture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-consignes-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('missing consignes file gives empty text', () => {
    assert.deepEqual(loadConsignes(path.join(dir, 'absent.md')), { text: '', hash: null, chars: 0, truncated: false });
    const blank = path.join(dir, 'blank.md');
    fs.writeFileSync(blank, '  \n\n ');
    assert.deepEqual(loadConsignes(blank), { text: '', hash: null, chars: 0, truncated: false });
  });

  test('long consignes are truncated at 8000', () => {
    const f = path.join(dir, 'long.md');
    fs.writeFileSync(f, 'a'.repeat(9000));
    const r = loadConsignes(f);
    assert.equal(r.chars, 8000);
    assert.equal(r.text.length, 8000);
    assert.equal(r.truncated, true);
    fs.writeFileSync(f, 'a'.repeat(8000));
    assert.equal(loadConsignes(f).truncated, false);
  });

  test('hash changes when text changes', () => {
    const f = path.join(dir, 'h.md');
    fs.writeFileSync(f, 'UAT = STG');
    const a = loadConsignes(f);
    assert.equal(loadConsignes(f).hash, a.hash);
    fs.writeFileSync(f, 'UAT = STG, recette = STG');
    assert.notEqual(loadConsignes(f).hash, a.hash);
    assert.equal(typeof a.hash, 'string');
  });

  test('consignes identical to the example are detected (doctor warns)', () => {
    const example = path.join(__dirname, '..', 'config', 'consignes-ia.example.md');
    const copy = path.join(dir, 'copie.md');
    fs.writeFileSync(copy, fs.readFileSync(example, 'utf8').replace(/\n/g, '\r\n') + '\n\n');
    assert.equal(sameAsExample(copy, example), true);
    fs.writeFileSync(copy, 'Les serveurs de production finissent par p.');
    assert.equal(sameAsExample(copy, example), false);
    assert.equal(sameAsExample(path.join(dir, 'absent.md'), example), false);
  });
});
