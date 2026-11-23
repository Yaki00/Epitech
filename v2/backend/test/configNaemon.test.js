'use strict';
const assert = require('assert').strict;

function naemonSource(value) {
  const old = process.env.NAEMON_SOURCE;
  process.env.NAEMON_SOURCE = value;
  try {
    let cfg;
    jest.isolateModules(() => {
      cfg = require('../src/config');
    });
    return cfg.naemon.source;
  } finally {
    if (old === undefined) delete process.env.NAEMON_SOURCE;
    else process.env.NAEMON_SOURCE = old;
  }
}

describe('configuration Naemon', () => {
  test('NAEMON_SOURCE=mock hors démo vaut off (pas de faux « mock » sans simulateur)', () => {
    assert.equal(naemonSource('mock'), 'off');
    assert.equal(naemonSource('thruk'), 'thruk');
    assert.equal(naemonSource('csv'), 'csv');
    assert.equal(naemonSource('nimporte'), 'off');
  });
});
