'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { ingestInventory } = require('../src/ingest/inventory');
const { createHistory } = require('../src/history/history');
const { impactOf } = require('../src/graph/impact');
const { loadPerimeter, createMatcher } = require('../src/perimeter/perimeter');

const mapping = {
  entity: 'server',
  key: 'Hostname',
  attrs: { ip: 'IP', ram: 'RAM' },
  perimeterColumn: 'Application',
  relations: [{ column: 'Application', entity: 'application', type: 'runs_on', direction: 'from' }],
};
const row = (Hostname, Application, IP = '10.0.0.1', RAM = '8') => ({ Hostname, Application, IP, RAM });

let repo;
let dir;
beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-history-'));
});

/** Importe, enregistre dans l'historique et applique les retraits, comme sync-inventory. */
function run(history, records, { matcher = null, complete = true, keep } = {}) {
  const stats = ingestInventory(repo, { source: 'inv', records, mapping, matcher });
  const change = history.recordImport({ source: 'inv', seen: stats.seen, attrsById: stats.seen.attrsById, complete: complete && stats.errors === 0 && records.length > 0 });
  history.applyRetirements(repo);
  return change;
}

describe('historique des imports', () => {
  test('records added/removed/changed between two imports', () => {
    const h = createHistory(dir);
    run(h, [row('srv1', 'Alto'), row('srv2', 'Alto')]);
    run(h, [row('srv1', 'Alto', '10.0.0.9'), row('srv3', 'Alto')]);
    const [last] = h.list(10);
    assert.equal(last.source, 'inv');
    assert.ok(last.added.includes('server:srv3'));
    assert.ok(last.removed.includes('server:srv2'));
    assert.deepEqual(last.changed, [{ id: 'server:srv1', attr: 'ip', before: '10.0.0.1', after: '10.0.0.9' }]);
    assert.ok(fs.existsSync(path.join(dir, 'changes.json')));
    assert.ok(fs.existsSync(path.join(dir, 'snapshots.json')));
  });

  test('incomplete import retires nothing', () => {
    const h = createHistory(dir);
    run(h, [row('srv1', 'Alto'), row('srv2', 'Alto')]);
    run(h, [row('srv1', 'Alto')], { complete: false });
    assert.equal(repo.getNode('server:srv2').attrs.retired, undefined);
    run(h, []);
    assert.equal(repo.getNode('server:srv2').attrs.retired, undefined);
    assert.equal(repo.getNode('server:srv1').attrs.retired, undefined);
    assert.equal(h.list(10).length, 0);
  });

  test('server moved from app A to B: edge A retired, impact of server no longer reaches A', () => {
    const h = createHistory(dir);
    run(h, [row('srv1', 'Alpha')]);
    assert.ok(impactOf(repo, 'server:srv1').items.some((i) => i.id === 'application:alpha'));
    run(h, [row('srv1', 'Beta')]);
    const ids = impactOf(repo, 'server:srv1').items.map((i) => i.id);
    assert.ok(ids.includes('application:beta'));
    assert.ok(!ids.includes('application:alpha'));
    assert.ok(impactOf(repo, 'server:srv1', { includeRetired: true }).items.some((i) => i.id === 'application:alpha'));
    assert.equal(repo.getNode('server:srv1').attrs.retired, undefined);
  });

  test('server reappearing is un-retired', () => {
    const h = createHistory(dir);
    run(h, [row('srv1', 'Alto'), row('srv2', 'Alto')]);
    run(h, [row('srv1', 'Alto')]);
    const n = repo.getNode('server:srv2');
    assert.equal(n.attrs.retired, true);
    assert.ok(n.attrs.retiredAt);
    assert.equal(impactOf(repo, 'server:srv1').items.length, 1);
    assert.equal(impactOf(repo, 'application:alto', { direction: 'downstream' }).items.some((i) => i.id === 'server:srv2'), false);
    run(h, [row('srv1', 'Alto'), row('srv2', 'Alto')]);
    assert.equal(repo.getNode('server:srv2').attrs.retired, undefined);
    assert.equal(repo.getNode('server:srv2').attrs.retiredAt, undefined);
    assert.ok(repo.edgesFrom('server:srv2').length + repo.edgesTo('server:srv2').length > 0);
    assert.ok(repo.allEdges().every((e) => !e.attrs.retired));
  });

  test('out-of-perimeter row keeps server alive', () => {
    const h = createHistory(dir);
    const file = path.join(dir, 'perimeter.json');
    fs.writeFileSync(file, JSON.stringify({ applications: ['Alto'] }));
    const matcher = createMatcher(loadPerimeter(file));
    run(h, [row('srv1', 'Alto'), row('srv2', 'Alto')], { matcher });
    // srv2 est maintenant rattaché à une application hors périmètre : elle sort du périmètre, pas du fichier
    run(h, [row('srv1', 'Alto'), row('srv2', 'Autre')], { matcher });
    assert.equal(repo.getNode('server:srv2').attrs.retired, undefined);
    assert.equal(repo.getNode('server:srv1').attrs.retired, undefined);
  });

  test('HISTORY_KEEP trims', () => {
    const h = createHistory(dir, { keep: 3 });
    for (let i = 0; i < 7; i++) run(h, [row('srv1', 'Alto', `10.0.0.${i}`)]);
    const list = h.list(100);
    assert.equal(list.length, 3);
    assert.equal(list[0].changed[0].after, '10.0.0.6');
    assert.equal(createHistory(dir, { keep: 3 }).list(100).length, 3);
  });

  test('alias spelling of a perimeter app does not retire its edge', () => {
    const h = createHistory(dir);
    const file = path.join(dir, 'perimeter.json');
    fs.writeFileSync(file, JSON.stringify({ applications: [{ name: 'Alto', aliases: ['ALTO-SA'] }] }));
    const matcher = createMatcher(loadPerimeter(file));
    run(h, [row('srv1', 'ALTO-SA')], { matcher });
    run(h, [row('srv1', 'ALTO-SA')], { matcher });
    const edges = repo.allEdges().filter((e) => e.type === 'runs_on');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].src, 'application:alto');
    assert.equal(edges[0].attrs.retired, undefined);
  });

  test('rows all dropped by the mapping filter retire nothing', () => {
    const h = createHistory(dir);
    const filtered = { ...mapping, filter: { Status: 'Active' } };
    const go = (records) => {
      const stats = ingestInventory(repo, { source: 'inv', records, mapping: filtered });
      h.recordImport({ source: 'inv', seen: stats.seen, attrsById: stats.seen.attrsById, complete: stats.errors === 0 && records.length > 0 && stats.seen.nodeIds.length > 0 });
      h.applyRetirements(repo);
    };
    go([{ ...row('srv1', 'Alto'), Status: 'Active' }]);
    go([{ ...row('srv1', 'Alto'), Status: 'Off' }]);
    assert.equal(repo.getNode('server:srv1').attrs.retired, undefined);
    assert.ok(repo.allEdges().every((e) => !e.attrs.retired));
    // défense dans recordImport lui-même
    assert.equal(h.recordImport({ source: 'inv', seen: { nodeIds: [], edgeIds: [] }, attrsById: {}, complete: true }), null);
  });
});
