'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { startNaemonPoller } = require('../src/naemon/setup');

describe('startNaemonPoller', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-nsetup-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = createRepo(openStore(':memory:'));
  const base = { dataDir: dir, reportsDir: path.join(dir, 'rapports'), perimeterFile: path.join(dir, 'absent.json'), root: dir };

  test('source off : aucun poller', () => {
    assert.equal(startNaemonPoller({ config: { ...base, naemon: { source: 'off' } }, repo }), null);
  });

  test('csv sans fichier : le poller existe, l\'erreur est exposée, rien ne plante', async () => {
    const p = startNaemonPoller({ config: { ...base, naemon: { source: 'csv', csvFile: path.join(dir, 'absent.csv'), pollMinutes: 5 } }, repo });
    assert.ok(p);
    await p.refresh();
    const s = p.snapshot();
    assert.equal(s.source, 'csv');
    assert.ok(s.lastError);
    p.stop();
  });

  test('csv valide : relève, état calculé et rapport d\'écarts écrit', async () => {
    const csv = path.join(dir, 'hosts.csv');
    fs.writeFileSync(csv, 'Hôte;Adresse;Statut\nsrv-x;10.0.0.1;UP\n');
    const cfg = { ...base, inventory: { mappingFile: path.join(dir, 'm.json') }, naemon: { source: 'csv', csvFile: csv, pollMinutes: 5 } };
    fs.writeFileSync(cfg.inventory.mappingFile, JSON.stringify({ naemon: { kind: 'hosts', columns: { name: 'A', address: 'B', state: 'C' } } }));
    const p = startNaemonPoller({ config: cfg, repo });
    await p.refresh();
    p.stop();
    const s = p.snapshot();
    assert.equal(s.lastError, null);
    assert.ok(s.lastOk);
    assert.ok(fs.readdirSync(base.reportsDir).some((f) => /^ecarts-/.test(f)));
  });
});
