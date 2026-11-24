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
const { createChatMock, askedDependencies } = require('../src/demo/chatMock');
const { createLlmClient } = require('../src/lib/llmClient');
const { ask } = require('../src/assistant/ask');
const { computeStatus } = require('../src/naemon/status');
const { docScore } = require('../src/quality/docScore');
const { serverEnv } = require('../src/lib/environment');
const { buildKnowledgeIndex } = require('../src/knowledge/search');

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

describe('mode démo : repérage par l\'IA', () => {
  const { repo, demo } = build();
  const { ownersOfApp } = require('../src/api/views');
  const { impactOf, isInactiveEdge } = require('../src/graph/impact');
  const perimeter = () => repo.listByType('application').filter((a) => a.attrs.perimeter);

  test('every perimeter app has an owner', () => {
    for (const a of perimeter()) {
      const owners = ownersOfApp(repo, a);
      assert.ok(owners.some((o) => o.kind === 'person' && o.role === 'owner' && o.period === 'current'), a.name);
      assert.ok(owners.some((o) => o.kind === 'team'), a.name);
    }
    const all = perimeter().flatMap((a) => ownersOfApp(repo, a));
    assert.ok(all.some((o) => o.period === 'past'));
    assert.ok(all.some((o) => o.source === 'apm' && o.id === null));
    const teamApps = {};
    for (const e of repo.allEdges().filter((x) => x.type === 'owned_by' && x.attrs.role === 'support' && repo.getNode(x.dst).type === 'team')) (teamApps[e.dst] ||= new Set()).add(e.src);
    assert.ok(Object.values(teamApps).some((s) => s.size >= 2));
    assert.ok(repo.listByType('person').length >= 8);
  });

  test('demo has past and toValidate links excluded from impact', () => {
    const llm = repo.allEdges().filter((e) => e.source === 'llm' && ['runs_on', 'uses_db', 'calls'].includes(e.type));
    const past = llm.filter((e) => e.attrs.period === 'past');
    const toValidate = llm.filter((e) => e.attrs.trust === 'toValidate');
    assert.ok(past.length >= 3);
    assert.equal(toValidate.length, 2);
    assert.ok([...past, ...toValidate].every(isInactiveEdge));
    for (const e of [...past, ...toValidate].filter((x) => x.type === 'runs_on')) {
      const hit = impactOf(repo, e.dst, { maxDepth: 1 }).items.map((i) => i.id);
      assert.ok(!hit.includes(e.src), `${e.src} ne doit pas dépendre de ${e.dst}`);
    }
    const added = llm.filter((e) => e.attrs.trust === 'added' && e.attrs.period === 'current');
    assert.ok(added.length >= 1 && !added.some(isInactiveEdge));
  });

  test('out of inventory server is created by the reading and supervised', () => {
    const ooi = repo.listByType('server').filter((s) => s.attrs.outOfInventory);
    assert.equal(ooi.length, 1);
    assert.equal(ooi[0].attrs.fromLlm, true);
    const mock = createMockNaemon(repo, { seed: 42, now: () => NOW });
    const raw = mock.fetchRaw(0);
    assert.ok(raw.hosts.some((h) => h.name === ooi[0].name));
    const st = computeStatus(repo, raw, { matcher: demo.matcher });
    assert.ok(st.servers[ooi[0].id]);
    assert.notEqual(st.servers[ooi[0].id].state, 'not_monitored');
  });

  test('documented_in carries a role, documents carry pageKindAi and period', () => {
    const docs = repo.allEdges().filter((e) => e.type === 'documented_in');
    assert.ok(docs.every((e) => ['subject', 'cited'].includes(e.attrs.role)));
    assert.ok(docs.some((e) => e.attrs.role === 'cited'));
    assert.ok(repo.listByType('document').every((d) => d.attrs.pageKindAi && d.attrs.period));
    assert.ok(repo.listByType('document').some((d) => d.attrs.period === 'past'));
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
  test('chat mock routes owner questions to owners_of', async () => {
    for (const q of ["Qui s'occupe de Atlas Paiements ?", 'Qui est responsable de Atlas Paiements ?']) {
      const r = await ask({ llm, repo, question: q });
      assert.deepEqual(r.toolTrace.map((t) => t.tool), ['owners_of'], q);
      assert.ok(r.answer.startsWith('[démo]'));
      assert.ok(/Claire Vasseur/.test(r.answer) && /owner/.test(r.answer));
    }
    const r = await ask({ llm, repo, question: 'Who owns Sirius Stocks?', lang: 'en', toolsMode: 'json' });
    assert.deepEqual(r.toolTrace.map((t) => t.tool), ['owners_of']);
    assert.ok(/Hugo Rinaldi \(person, owner, former\)/.test(r.answer));
  });
  test('sens de la question : ce dont X a besoin ou ce qui dépend de X (FR et EN)', () => {
    const deps = [
      'De quoi dépend Atlas Paiements ?',
      'Atlas Paiements dépend de quoi ?',
      'De quoi a besoin Atlas Paiements ?',
      'Quelles sont les dépendances de Atlas Paiements ?',
      'Qu’est-ce que Atlas Paiements utilise ?',
      'Sur quels serveurs tourne Atlas Paiements ?',
      'What does Atlas Paiements depend on?',
      'What does Atlas Paiements need?',
      'What does Atlas Paiements use?',
      'Atlas Paiements depends on what?',
    ];
    const impact = [
      "Qu'est-ce qui dépend de Atlas Paiements ?",
      'Qu’est-ce qui dépend de Atlas Paiements ?',
      'Qui utilise Atlas Paiements ?',
      'Quelles applications dépendent de Atlas Paiements ?',
      'Que se passe-t-il si Atlas Paiements tombe ?',
      'What depends on Atlas Paiements?',
      'Who uses Atlas Paiements?',
      'What happens if Atlas Paiements goes down?',
      'Atlas Paiements',
    ];
    for (const q of deps) assert.equal(askedDependencies(q), true, q);
    for (const q of impact) assert.equal(askedDependencies(q), false, q);
  });
  test('« Qu’est-ce qui dépend de X ? » passe par l’analyse d’impact, « De quoi dépend X ? » par les dépendances', async () => {
    const r = await ask({ llm, repo, question: "Qu'est-ce qui dépend de Atlas Paiements ?" });
    assert.deepEqual(r.toolTrace.map((t) => t.tool), ['impact_analysis']);
    assert.ok(/Helios Commandes/.test(r.answer));
    const r2 = await ask({ llm, repo, question: 'What does Atlas Paiements depend on?', lang: 'en' });
    assert.deepEqual(r2.toolTrace.map((t) => t.tool), ['dependencies']);
  });
});

describe('mode démo : fiches', () => {
  const { repo, demo } = build();
  const fiches = repo.listByType('fiche');
  const llm = createLlmClient({ mock: true, models: {}, concurrency: 2, maxRetries: 0 }, { mockHandler: createChatMock(repo), logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const knowledge = { index: buildKnowledgeIndex(repo), matcher: demo.matcher };

  test('demo has fiches of each kind linked to applications', () => {
    for (const kind of ['incident', 'correctif', 'procedure', 'pratique']) {
      const of = fiches.filter((f) => f.attrs.kind === kind);
      assert.ok(of.length >= 1 && of.length <= 3, kind);
      for (const f of of) {
        assert.ok(repo.edgesFrom(f.id).some((e) => e.type === 'concerne' && e.dst.startsWith('application:')), f.id);
        assert.ok(repo.edgesFrom(f.id).some((e) => e.type === 'vient_de'), f.id);
        assert.ok(/^https:\/\/wiki\.example\.local\//.test(f.attrs.url));
      }
    }
    // une procédure remplacée par une plus récente, un correctif qui corrige un incident
    const old = fiches.find((f) => f.attrs.kind === 'procedure' && f.attrs.replacedBy);
    assert.ok(old && repo.getNode(old.attrs.replacedBy).attrs.kind === 'procedure');
    assert.ok(fiches.some((f) => repo.edgesFrom(f.id).some((e) => e.type === 'corrige')));
  });

  test('demo chat answers a procedure question with sources', async () => {
    for (const q of ["Comment relancer l'encaissement d'Atlas Paiements ?", 'Erreur SMTP-451 sur Vega Facturation', 'Incident sur les commandes bloquées']) {
      const r = await ask({ llm, repo, question: q, knowledge });
      assert.ok(r.toolTrace.some((t) => t.tool === 'search_knowledge'), q);
      assert.ok(r.answer.startsWith('[démo]'));
      assert.ok(r.sources.length >= 1, q);
      assert.ok(r.answer.includes(r.sources[0].url), q);
    }
    const none = await ask({ llm, repo, question: 'Comment zzzqqq ?', knowledge });
    assert.equal(none.sources.length, 0);
    assert.ok(/rien trouvé/.test(none.answer));
  });
});

test('aucun tiret long dans les sources de démo', () => {
  for (const f of ['generate.js', 'naemonMock.js', 'chatMock.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'demo', f), 'utf8');
    assert.ok(!/[\u2013\u2014]/.test(text), f);
  }
});
