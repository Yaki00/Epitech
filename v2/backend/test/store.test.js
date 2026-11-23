'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore, acquireLock } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-store-'));

function fill(repo) {
  const s = repo.upsertNode({ type: 'server', key: 'SRV01.dom.example.com', aliases: ['10.0.0.1'], source: 'mp', attrs: { ram: '16' } });
  const a = repo.upsertNode({ type: 'application', key: 'ALTO', name: 'ALTO', source: 'apm' });
  repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'mp', sourceRef: 'l2' });
  const run = repo.startRun('test');
  repo.recordError(run, { source: 'test', ref: 'x', step: 'parse', message: 'boom' });
  repo.finishRun(run, { status: 'partial', stats: { n: 1 } });
  repo.saveDocument({ id: 'confluence:1', source: 'confluence', title: 'T', contentHash: 'h', status: 'parsed' });
  return { s, a, run };
}

describe('stockage JSON', () => {
  test('sauvegarde puis rechargement : mêmes données', () => {
    const dir = tmp();
    const repo = createRepo(openStore(dir));
    const { run } = fill(repo);
    repo.flush();
    const again = createRepo(openStore(dir));
    assert.deepEqual(again.countByType(), { server: 1, application: 1 });
    assert.equal(again.resolve('10.0.0.1')[0].id, 'server:srv01');
    assert.equal(again.edgesFrom('application:alto')[0].dst, 'server:srv01');
    assert.equal(again.getNode('server:srv01').attrs.ram, '16');
    assert.equal(again.lastRuns(1)[0].status, 'partial');
    assert.equal(again.errorsOfRun(run)[0].message, 'boom');
    assert.equal(again.getDocument('confluence:1').content_hash, 'h');
    // les compteurs reprennent après rechargement (pas de doublon d'id)
    assert.equal(again.startRun('suite'), run + 1);
  });
  test('lien idempotent : même id, confiance mise à jour', () => {
    const repo = createRepo(openStore(':memory:'));
    fill(repo);
    const before = repo.edgesFrom('application:alto')[0];
    repo.addEdge({ src: 'application:alto', dst: 'server:srv01', type: 'runs_on', source: 'mp', sourceRef: 'l2', confidence: 0.9 });
    const after = repo.edgesFrom('application:alto');
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before.id);
    assert.equal(after[0].confidence, 0.9);
  });
  test('modifier un objet renvoyé ne modifie pas le stockage', () => {
    const repo = createRepo(openStore(':memory:'));
    fill(repo);
    repo.getNode('server:srv01').attrs.ram = '999';
    assert.equal(repo.getNode('server:srv01').attrs.ram, '16');
  });
  test('recherche par nom ou alias, sans tenir compte de la casse', () => {
    const repo = createRepo(openStore(':memory:'));
    fill(repo);
    assert.deepEqual(repo.search('Srv0').map((n) => n.id), ['server:srv01']);
    assert.deepEqual(repo.search('10.0.0').map((n) => n.id), ['server:srv01']);
    assert.deepEqual(repo.search('alt').map((n) => n.id), ['application:alto']);
  });
  test('le serveur API recharge après une synchro faite par un autre processus', () => {
    const dir = tmp();
    const api = createRepo(openStore(dir));
    assert.equal(api.reloadIfChanged(), false);
    const sync = createRepo(openStore(dir));
    fill(sync);
    sync.flush();
    assert.equal(api.reloadIfChanged(), true);
    assert.equal(api.countByType().server, 1);
    assert.equal(api.reloadIfChanged(), false);
  });
  test('fichier corrompu : erreur explicite', () => {
    const dir = tmp();
    const repo = createRepo(openStore(dir));
    fill(repo);
    repo.flush();
    fs.writeFileSync(path.join(dir, 'nodes.json'), '{pas du json');
    assert.throws(() => openStore(dir), /illisible/);
  });
  test('verrou : une seule synchro à la fois', () => {
    const dir = tmp();
    const release = acquireLock(dir);
    fs.writeFileSync(path.join(dir, '.sync.lock'), String(process.ppid)); // un autre processus vivant
    assert.throws(() => acquireLock(dir), /synchro tourne déjà/);
    fs.writeFileSync(path.join(dir, '.sync.lock'), '999999999'); // processus mort : verrou repris
    const again = acquireLock(dir);
    again();
    release();
    assert.ok(!fs.existsSync(path.join(dir, '.sync.lock')));
  });
});
