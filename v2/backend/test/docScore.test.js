'use strict';
const assert = require('assert').strict;
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { docScore } = require('../src/quality/docScore');

let repo;
beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
});

const app = (attrs = {}) => repo.upsertNode({ type: 'application', key: 'ALTO', name: 'ALTO', source: 'apm', attrs });
const server = (key, attrs = {}) => repo.upsertNode({ type: 'server', key, source: 'apm', attrs });
const page = (key, attrs = {}) => repo.upsertNode({ type: 'document', key, name: key, source: 'confluence', attrs });
const part = (r, key) => r.parts.find((p) => p.key === key);

function fullApp({ audit = { ok: true, problems: [] } } = {}) {
  const a = app({ summary: 'Une application de test.' });
  const s1 = server('srvalto01');
  const s2 = server('srvalto02');
  repo.addEdge({ src: a, dst: s1, type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: a, dst: s2, type: 'runs_on', source: 'apm' });
  const d = page('page-1', { pageKind: 'architecture' });
  repo.addEdge({ src: a, dst: d, type: 'documented_in', source: 'confluence', attrs: { audit } });
  repo.addEdge({ src: d, dst: s1, type: 'mentions', source: 'confluence' });
  repo.addEdge({ src: d, dst: s2, type: 'mentions', source: 'confluence' });
  return { a, s1, s2, d };
}

describe('score de documentation', () => {
  test('application vide : 0, avec le détail des quatre critères', () => {
    const a = app();
    const r = docScore(repo, a);
    assert.equal(r.score, 0);
    assert.deepEqual(r.parts.map((p) => p.key), ['architecture', 'architectureClean', 'serversDocumented', 'summary']);
    assert.deepEqual(r.parts.map((p) => p.max), [35, 25, 30, 10]);
    for (const p of r.parts) assert.ok(p.detail && typeof p.detail === 'string');
  });
  test('application complète : 100', () => {
    const { a } = fullApp();
    const r = docScore(repo, a);
    assert.equal(r.score, 100);
    assert.equal(r.parts.reduce((s, p) => s + p.points, 0), 100);
  });
  test('la moitié des serveurs cités : 15 sur ce critère', () => {
    const { a, s2, d } = fullApp();
    const e = repo.edgesFrom(d).find((x) => x.type === 'mentions' && x.dst === s2);
    repo.patchEdgeAttrs(e.id, { retired: true });
    const r = docScore(repo, a);
    assert.equal(part(r, 'serversDocumented').points, 15);
    assert.match(part(r, 'serversDocumented').detail, /1 serveur cité sur 2/);
    assert.equal(r.score, 85);
  });
  test("page d'architecture en écart : 35 mais 0 sur la cohérence", () => {
    const { a } = fullApp({ audit: { ok: false, problems: [{ code: 'missing', n: 1 }] } });
    const r = docScore(repo, a);
    assert.equal(part(r, 'architecture').points, 35);
    assert.equal(part(r, 'architectureClean').points, 0);
  });
  test("sans page d'architecture : 0 aux deux critères, même avec une page ordinaire", () => {
    const a = app();
    const d = page('autre');
    repo.addEdge({ src: a, dst: d, type: 'documented_in', source: 'confluence' });
    const r = docScore(repo, a);
    assert.equal(part(r, 'architecture').points, 0);
    assert.equal(part(r, 'architectureClean').points, 0);
  });
  test('serveurs et pages retirés ignorés', () => {
    const { a, s2, d } = fullApp();
    repo.patchNodeAttrs(s2, { retired: true });
    assert.equal(docScore(repo, a).score, 100);
    repo.patchNodeAttrs(d, { retired: true });
    const r = docScore(repo, a);
    assert.equal(part(r, 'architecture').points, 0);
    assert.equal(part(r, 'serversDocumented').points, 0);
  });
  test('serveur cité par son nom dans le contrôle de la page (confirmed)', () => {
    const a = app();
    const s = server('srvx01');
    repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'apm' });
    const d = page('p', { pageKind: 'architecture' });
    repo.addEdge({ src: a, dst: d, type: 'documented_in', source: 'confluence', attrs: { audit: { ok: true, confirmed: ['srvx01'] } } });
    assert.equal(part(docScore(repo, a), 'serversDocumented').points, 30);
  });
});
