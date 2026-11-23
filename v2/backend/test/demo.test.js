'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createHistory } = require('../src/history/history');
const { generateDemo } = require('../src/demo/generate');
const { createMockNaemon } = require('../src/demo/naemonMock');
const { createChatMock } = require('../src/demo/chatMock');
const { createLlmClient } = require('../src/lib/llmClient');
const { ask } = require('../src/assistant/ask');
const { computeStatus } = require('../src/naemon/status');
const { docScore } = require('../src/quality/docScore');
const { serverEnv } = require('../src/lib/environment');

const NOW = Date.parse('2026-11-20T10:00:00Z');
const tmpDirs = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function build(seed = 42) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-demo-'));
  tmpDirs.push(dir);
  const repo = createRepo(openStore(':memory:'));
  const history = createHistory(dir);
  const demo = generateDemo(repo, history, { seed, now: NOW, dir });
  const d = repo.store.data;
  const dump = JSON.stringify({ nodes: [...d.nodes.values()], edges: [...d.edges.values()], docs: [...d.documents.values()], changes: history.list(10) });
  return { repo, history, demo, dump };
}

describe('mode démo : jeu de données', () => {
  const { repo, history, demo, dump } = build();

  test('même graine, même graphe ; autre graine, autre graphe', () => {
    assert.equal(build(42).dump, dump);
    assert.notEqual(build(7).dump, dump);
  });

  test('12 applications du périmètre, 4 hors périmètre, avec criticité', () => {
    const apps = repo.listByType('application');
    assert.equal(apps.filter((a) => a.attrs.perimeter === true).length, 12);
    assert.equal(apps.filter((a) => !a.attrs.perimeter).length, 4);
    assert.ok(apps.filter((a) => a.attrs.perimeter).every((a) => a.attrs.criticality));
    assert.equal(demo.matcher.apps.length, 12);
  });

  test('chaque application PRD a au moins 2 serveurs PRD et 1 STG ; IP en 10.x', () => {
    for (const a of repo.listByType('application').filter((x) => x.attrs.perimeter)) {
      const servers = repo
        .edgesFrom(a.id)
        .filter((e) => e.type === 'runs_on' && !e.attrs.retired)
        .map((e) => repo.getNode(e.dst));
      assert.ok(servers.filter((s) => serverEnv(s) === 'PRD').length >= 2, `${a.name} PRD`);
      assert.ok(servers.filter((s) => serverEnv(s) === 'STG').length >= 1, `${a.name} STG`);
    }
    const servers = repo.listByType('server');
    assert.ok(servers.length >= 75 && servers.length <= 95, `serveurs : ${servers.length}`);
    assert.ok(servers.every((s) => /^10\./.test(s.attrs.ip)));
    assert.equal(new Set(servers.map((s) => s.attrs.ip)).size, servers.length);
    assert.ok(servers.filter((s) => serverEnv(s) === null && !s.attrs.retired).length >= 2);
  });

  test('2 serveurs retirés, 3 imports dont 2 avec des changements', () => {
    assert.equal(repo.listByType('server').filter((s) => s.attrs.retired).length, 2);
    const changes = history.list(10);
    assert.equal(changes.length, 2);
    assert.ok(changes.every((c) => c.added.length && c.removed.length && c.changed.length >= 0));
    assert.ok(changes.some((c) => c.changed.length));
  });

  test('30 documents, pages d\'architecture avec et sans écart, scores de doc étalés', () => {
    assert.equal(repo.listByType('document').length, 30);
    const archi = repo.listByType('document').filter((d) => d.attrs.pageKind === 'architecture');
    assert.ok(archi.length >= 10);
    const audits = repo.allEdges().filter((e) => e.type === 'documented_in' && e.attrs.audit);
    assert.ok(audits.some((e) => e.attrs.audit.ok === true));
    assert.ok(audits.some((e) => e.attrs.audit.ok === false));
    const scores = repo.listByType('application').filter((a) => a.attrs.perimeter).map((a) => docScore(repo, a.id).score);
    assert.ok(Math.min(...scores) <= 20, `min ${Math.min(...scores)}`);
    assert.equal(Math.max(...scores), 100);
    assert.ok(repo.listByType('document').every((d) => /^https:\/\/wiki\.example\.local\//.test(d.attrs.url)));
  });

  test('bases partagées et chaînes calls de 2 à 3 niveaux', () => {
    const users = {};
    for (const e of repo.allEdges().filter((x) => x.type === 'uses_db')) (users[e.dst] ||= []).push(e.src);
    assert.ok(Object.values(users).some((l) => l.length >= 2));
    assert.ok(repo.allEdges().filter((e) => e.type === 'calls').length >= 10);
  });
});

describe('mode démo : Naemon simulé', () => {
  const { repo, demo } = build();
  const mock = createMockNaemon(repo, { seed: 42, now: () => NOW });

  test('le tick 0 donne down, degraded, atRisk et maintenance', () => {
    const st = computeStatus(repo, mock.fetchRaw(0), { matcher: demo.matcher });
    const servers = Object.values(st.servers);
    assert.ok(servers.filter((s) => s.state === 'down').length >= 2);
    assert.ok(servers.some((s) => s.state === 'maintenance'));
    assert.ok(servers.some((s) => s.state === 'warning' && s.ack));
    const apps = Object.values(st.apps);
    assert.ok(apps.some((a) => a.state === 'down'));
    assert.ok(apps.some((a) => a.state === 'degraded'));
    assert.ok(Object.keys(st.atRisk).length >= 1);
    assert.ok(Object.values(st.atRisk).every((r) => r.path.length >= 2));
    assert.ok(st.unmatchedHosts.length >= 1);
  });

  test('chaque tick change une alerte, deterministe', () => {
    const alerts = (t) => {
      const raw = mock.fetchRaw(t);
      return raw.services.filter((s) => s.state > 0 && !s.ack).map((s) => `${s.host}/${s.description}`).sort();
    };
    assert.notDeepEqual(alerts(0), alerts(1));
    assert.notDeepEqual(alerts(1), alerts(2));
    assert.deepEqual(alerts(3), alerts(3));
    const again = createMockNaemon(repo, { seed: 42, now: () => NOW });
    assert.deepEqual(again.fetchRaw(5), mock.fetchRaw(5));
  });
});

describe('mode démo : chat simulé', () => {
  const { repo } = build();
  const llm = createLlmClient({ mock: true, models: {}, concurrency: 2, maxRetries: 0 }, { mockHandler: createChatMock(repo), logger: { debug() {}, info() {}, warn() {}, error() {} } });

  test('répond à partir des outils, préfixé [démo]', async () => {
    const r = await ask({ llm, repo, question: 'Que se passe-t-il si Atlas Paiements tombe ?' });
    assert.ok(r.answer.startsWith('[démo]'));
    assert.ok(r.toolTrace.some((t) => t.tool === 'impact_analysis'));
    assert.ok(/Helios Commandes/.test(r.answer));
  });
  test('mode json et question sans entité', async () => {
    const r = await ask({ llm, repo, question: 'De quoi dépend Helios Commandes ?', toolsMode: 'json' });
    assert.ok(r.answer.startsWith('[démo]'));
    assert.ok(r.toolTrace.some((t) => t.tool === 'dependencies'));
    const r2 = await ask({ llm, repo, question: 'bonjour' });
    assert.ok(r2.answer.startsWith('[démo]'));
  });
});

test('aucun tiret long dans les sources de démo', () => {
  for (const f of ['generate.js', 'naemonMock.js', 'chatMock.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'demo', f), 'utf8');
    assert.ok(!/[\u2013\u2014]/.test(text), f);
  }
});
