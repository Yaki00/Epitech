'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createHistory } = require('../src/history/history');
const { generateDemo } = require('../src/demo/generate');
const { createMockNaemon } = require('../src/demo/naemonMock');
const { computeStatus } = require('../src/naemon/status');
const { impactOf } = require('../src/graph/impact');
const { createApp } = require('../src/api/app');

const NOW = Date.parse('2026-11-20T10:00:00Z');
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-api2-'));
  dirs.push(dir);
  const repo = createRepo(openStore(':memory:'));
  const history = createHistory(dir);
  const demo = generateDemo(repo, history, { seed: 42, now: NOW, dir });
  const mock = createMockNaemon(repo, { seed: 42, now: () => NOW });
  const status = computeStatus(repo, mock.fetchRaw(0), { matcher: demo.matcher });
  const poller = { snapshot: () => ({ status, source: 'mock', lastOk: '2026-11-20T10:00:00.000Z', lastError: null, nextAt: null }) };
  const config = { demo: true, naemon: { source: 'off', urlTemplate: 'http://n/{app}' }, reportsDir: path.join(dir, 'rapports') };
  return { dir, repo, history, status, poller, config };
}

describe('API v2 (graphe démo)', () => {
  const ctx = build();
  const app = createApp({ repo: ctx.repo, llm: null, poller: ctx.poller, history: ctx.history, config: ctx.config });
  const get = (url) => request(app).get(url);

  test('GET /api/overview : forme attendue', async () => {
    const r = await get('/api/overview').expect(200);
    const o = r.body;
    assert.equal(o.counts.applications, 12);
    assert.ok(o.counts.servers > 0);
    assert.equal(o.apps.length, 12);
    assert.deepEqual(Object.keys(o.apps[0]).sort(), ['criticality', 'docScore', 'id', 'name', 'state']);
    assert.equal(typeof o.apps[0].docScore, 'number');
    assert.ok(o.apps.some((a) => a.state === 'down'));
    assert.ok(o.alerts.length >= 2);
    assert.deepEqual(Object.keys(o.alerts[0]).sort(), ['ack', 'apps', 'name', 'output', 'serverId', 'state']);
    assert.ok(o.atRisk.length >= 1);
    assert.ok(o.atRisk[0].path.length >= 2);
    assert.ok(o.sources.length >= 2);
    assert.ok(o.sources.every((s) => s.source && 'lastRun' in s && s.status));
    assert.ok(o.sources.some((s) => s.source === 'naemon'));
    assert.ok(o.recentChanges.length > 0 && o.recentChanges.length <= 5);
    assert.ok(o.gaps.counts && 'notMonitored' in o.gaps.counts);
    assert.equal(o.lowestDocs.length, 3);
    assert.ok(o.lowestDocs[0].docScore <= o.lowestDocs[2].docScore);
    assert.equal(o.naemon.lastOk, '2026-11-20T10:00:00.000Z');
    assert.equal(o.naemon.lastError, null);
  });

  test('GET /api/status : états Naemon et source', async () => {
    const s = (await get('/api/status').expect(200)).body;
    assert.equal(s.source, 'mock');
    assert.ok(Object.keys(s.servers).length > 50);
    assert.ok(Object.values(s.apps).some((a) => a.state === 'down'));
    assert.ok(Array.isArray(s.unmatchedHosts));
    assert.equal(s.lastError, null);
  });

  test('GET /api/gaps : écarts avec serveurs résolus', async () => {
    const g = (await get('/api/gaps').expect(200)).body;
    assert.equal(g.available, true);
    assert.equal(g.counts.notMonitored, g.notMonitored.length);
    assert.ok(g.counts.unknownMonitored >= 1);
    if (g.notMonitored.length) assert.deepEqual(Object.keys(g.notMonitored[0]).sort(), ['env', 'id', 'ip', 'name']);
    const csv = await get('/api/gaps?format=csv').expect(200);
    assert.match(csv.headers['content-type'], /csv/);
  });

  test('GET /api/changes?limit=', async () => {
    const all = (await get('/api/changes').expect(200)).body;
    assert.ok(all.length >= 2);
    assert.ok(all[0].at && Array.isArray(all[0].added) && typeof all[0].labels === 'object');
    assert.equal((await get('/api/changes?limit=1').expect(200)).body.length, 1);
  });

  test('GET /api/servers/:id : fiche serveur ; inconnu = 404', async () => {
    const down = Object.entries(ctx.status.servers).find(([, s]) => s.state === 'down')[0];
    const d = (await get(`/api/servers/${encodeURIComponent(down)}`).expect(200)).body;
    assert.equal(d.id, down);
    assert.equal(d.state, 'down');
    assert.equal(d.env, 'PRD');
    assert.equal(d.retired, false);
    assert.ok(d.applications.length >= 1);
    assert.ok(Array.isArray(d.services) && Array.isArray(d.documents) && Array.isArray(d.changes));
    await get('/api/servers/server:nexiste-pas').expect(404);
    await get(`/api/servers/${encodeURIComponent('application:atlas-paiements')}`).expect(404);
  });

  test('POST /api/simulate : union des impacts', async () => {
    const [a, b] = ['application:sirius-stocks', 'database:base-catalogue'];
    const one = async (ids) => (await request(app).post('/api/simulate').send({ nodeIds: ids }).expect(200)).body;
    const ra = await one([a]);
    const rb = await one([b]);
    const both = await one([a, b]);
    const ids = (r) => r.impacted.map((i) => i.id).sort();
    const expected = new Set([...ids(ra), ...ids(rb)].filter((x) => x !== a && x !== b));
    assert.deepEqual(ids(both), [...expected].sort());
    assert.deepEqual(Object.keys(both.impacted[0]).sort(), ['depth', 'id', 'name', 'type', 'via']);
    assert.equal(both.impacted.length, Object.values(both.byType).reduce((n, l) => n + l.length, 0));
    // cohérent avec impactOf pour un seul nœud
    assert.deepEqual(ids(ra), impactOf(ctx.repo, a, {}).items.map((i) => i.id).sort());
    await request(app).post('/api/simulate').send({ nodeIds: [] }).expect(400);
    await request(app).post('/api/simulate').send({}).expect(400);
    const unk = await one(['server:inconnu']);
    assert.deepEqual(unk.impacted, []);
    assert.deepEqual(unk.unknown, ['server:inconnu']);
  });

  test('GET /api/map : sans envs, aucun serveur DEV', async () => {
    const m = (await get('/api/map?scope=perimeter').expect(200)).body;
    const servers = m.nodes.filter((n) => n.type === 'server');
    assert.ok(servers.length > 0);
    assert.ok(servers.every((n) => n.env !== 'DEV'));
    assert.ok(m.nodes.some((n) => n.type === 'application') && m.nodes.some((n) => n.type === 'database'));
    assert.deepEqual(Object.keys(m.nodes[0]).sort(), ['appIds', 'criticality', 'env', 'id', 'label', 'retired', 'state', 'type']);
    assert.deepEqual(Object.keys(m.edges[0]).sort(), ['id', 'retired', 'source', 'target', 'type']);
    const ids = new Set(m.nodes.map((n) => n.id));
    assert.ok(m.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
    const withDev = (await get('/api/map?scope=perimeter&envs=PRD,STG,DEV').expect(200)).body;
    assert.ok(withDev.nodes.some((n) => n.env === 'DEV'));
    const srv = withDev.nodes.find((n) => n.type === 'server' && n.env === 'PRD');
    assert.ok(srv.appIds.length >= 1);
  });

  test('GET /api/map?scope=app:<id> ; app inconnue 404 ; scope invalide 400', async () => {
    const m = (await get('/api/map?scope=app:atlas-paiements').expect(200)).body;
    assert.ok(m.nodes.some((n) => n.id === 'application:atlas-paiements'));
    assert.ok(m.nodes.filter((n) => n.type === 'server').length >= 2);
    assert.ok(m.nodes.length < (await get('/api/map?scope=perimeter').expect(200)).body.nodes.length);
    await get('/api/map?scope=app:nexiste-pas').expect(404);
    await get('/api/map?scope=foo').expect(400);
  });

  test('GET /api/config : demo, naemonSource, version, modèle de lien', async () => {
    const c = (await get('/api/config').expect(200)).body;
    assert.equal(c.demo, true);
    assert.equal(c.naemonSource, 'mock');
    assert.match(c.version, /^\d+\.\d+\.\d+/);
    assert.ok('naemonUrlTemplate' in c);
  });

  test('applications : status, docScore, retired ; serveurs : env, retired, state', async () => {
    const list = (await get('/api/applications').expect(200)).body;
    const a = list.find((x) => x.id === 'application:sirius-stocks');
    assert.equal(a.status.state, 'down');
    assert.equal(typeof a.docScore.score, 'number');
    assert.equal(a.retired, false);
    const d = (await get('/api/applications/application:sirius-stocks').expect(200)).body;
    assert.ok(d.serverList.every((s) => 'state' in s && 'retired' in s && 'env' in s));
    const servers = (await get('/api/servers?q=srv-').expect(200)).body;
    assert.ok(servers.every((s) => 'state' in s && 'retired' in s));
  });

  test('un serveur retiré est signalé et exclu de la carte par défaut', async () => {
    const c = build();
    const victim = c.repo.listByType('server').find((n) => n.name === 'srv-atp-prd1');
    c.repo.patchNodeAttrs(victim.id, { retired: true, retiredAt: '2026-11-21T00:00:00Z' });
    const a2 = createApp({ repo: c.repo, llm: null, poller: c.poller, history: c.history, config: c.config });
    const d = (await request(a2).get(`/api/servers/${encodeURIComponent(victim.id)}`).expect(200)).body;
    assert.equal(d.retired, true);
    const m = (await request(a2).get('/api/map?scope=perimeter').expect(200)).body;
    assert.ok(!m.nodes.some((n) => n.id === victim.id));
    const m2 = (await request(a2).get('/api/map?scope=perimeter&includeRetired=true').expect(200)).body;
    assert.equal(m2.nodes.find((n) => n.id === victim.id).retired, true);
  });
});

describe('API v2 sans supervision ni historique', () => {
  const ctx = build();
  const app = createApp({ repo: ctx.repo, llm: null, config: { demo: false, naemon: { source: 'off' } } });

  test('/api/status répond 200, source off, aucun état', async () => {
    const s = (await request(app).get('/api/status').expect(200)).body;
    assert.equal(s.source, 'off');
    assert.deepEqual(s.servers, {});
    assert.deepEqual(s.apps, {});
    assert.equal(s.lastOk, null);
  });

  test('overview, gaps, changes, map : 200 sans faux zéros', async () => {
    const o = (await request(app).get('/api/overview').expect(200)).body;
    assert.equal(o.naemon.source, 'off');
    assert.deepEqual(o.alerts, []);
    assert.ok(o.apps.every((a) => a.state === 'unknown'));
    assert.deepEqual(o.recentChanges, []);
    assert.ok(o.sources.some((s) => s.source === 'naemon' && s.status === 'off'));
    const g = (await request(app).get('/api/gaps').expect(200)).body;
    assert.equal(g.available, false);
    assert.deepEqual((await request(app).get('/api/changes').expect(200)).body, []);
    const m = (await request(app).get('/api/map?scope=perimeter').expect(200)).body;
    assert.ok(m.nodes.every((n) => n.type !== 'server' || n.state === 'unknown'));
    assert.equal((await request(app).get('/api/config').expect(200)).body.naemonSource, 'off');
  });
});
