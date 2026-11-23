'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { computeGaps, writeGapsReport } = require('../src/naemon/gaps');

let repo;
const addApp = (name, perimeter = true) => repo.upsertNode({ type: 'application', key: name, name, attrs: perimeter ? { perimeter: true } : {}, source: 't' });
const addSrv = (name, app, attrs = {}) => {
  const id = repo.upsertNode({ type: 'server', key: name, name, attrs, source: 't' });
  if (app) repo.addEdge({ src: `application:${app}`, dst: id, type: 'runs_on', source: 't' });
  return id;
};

beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
});

describe('computeGaps', () => {
  test('serveurs non supervisés du périmètre, hôtes inconnus, cités absents des inventaires', () => {
    addApp('alto');
    addApp('autre', false);
    const ok = addSrv('srvalto01', 'alto');
    const miss = addSrv('srvalto02', 'alto');
    const hors = addSrv('srvautre01', 'autre'); // application hors périmètre : ignorée
    const orphelin = addSrv('srvsansapp', null); // aucune application : ignoré
    const retired = addSrv('srvalto03', 'alto', { retired: { at: '2026-11-01' } });
    const doc = repo.upsertNode({ type: 'document', key: 'p1', name: 'Architecture alto', attrs: {}, source: 't' });
    repo.addEdge({ src: 'application:alto', dst: doc, type: 'documented_in', source: 't', attrs: { audit: { unknown: ['srvghost01', 'SRVGHOST01', 'srvghost02'] } } });
    const status = {
      servers: {
        [ok]: { state: 'ok' },
        [miss]: { state: 'not_monitored' },
        [hors]: { state: 'not_monitored' },
        [orphelin]: { state: 'not_monitored' },
        [retired]: { state: 'not_monitored' },
      },
      unmatchedHosts: ['hostinconnu01'],
    };
    const g = computeGaps(repo, status);
    assert.deepEqual(g.notMonitored.map((s) => s.name), ['srvalto02']);
    assert.deepEqual(g.unknownMonitored, ['hostinconnu01']);
    assert.deepEqual(g.citedNotInInventory, ['srvghost01', 'srvghost02']);
  });

  test('sans état Naemon : aucun serveur compté non supervisé', () => {
    addApp('alto');
    addSrv('srvalto01', 'alto');
    const g = computeGaps(repo, null);
    assert.deepEqual(g, { notMonitored: [], unknownMonitored: [], citedNotInInventory: [] });
  });
});

describe('writeGapsReport', () => {
  test('écrit ecarts-naemon.csv avec les trois catégories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-ecarts-'));
    const file = writeGapsReport(dir, { notMonitored: [{ name: 'srvalto02', attrs: { ip: '10.0.0.2', environment: 'PRD' } }], unknownMonitored: ['hostinconnu01'], citedNotInInventory: ['srvghost01'] });
    assert.ok(path.basename(file).startsWith('ecarts-'));
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('srvalto02'));
    assert.ok(text.includes('hostinconnu01'));
    assert.ok(text.includes('srvghost01'));
  });
});
