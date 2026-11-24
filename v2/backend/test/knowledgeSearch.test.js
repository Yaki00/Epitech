'use strict';
const assert = require('assert').strict;
const request = require('supertest');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { applyFiches, linkFiches } = require('../src/knowledge/apply');
const { buildKnowledgeIndex, searchKnowledge, getFiche } = require('../src/knowledge/search');
const { createApp } = require('../src/api/app');

const item = (text, evidence = text) => ({ text, evidence });
const PERIMETER = {
  applications: [
    { name: 'OrderHub', aliases: [], auid: null },
    { name: 'Marelle', aliases: [], auid: null },
    { name: 'Gestion Commerciale Entreprises', aliases: [], auid: null },
    { name: 'Solo', aliases: [], auid: null },
  ],
  ignoreOtherApplications: true,
};
const APP = (n) => `application:${n}`;

function world() {
  const repo = createRepo(openStore(':memory:'));
  ensurePerimeterNodes(repo, PERIMETER);
  for (const s of ['srvshared01', 'srvsolo01']) repo.upsertNode({ type: 'server', key: s, name: s, source: 'apm' });
  repo.addEdge({ src: APP('orderhub'), dst: 'server:srvshared01', type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: APP('marelle'), dst: 'server:srvshared01', type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: APP('solo'), dst: 'server:srvsolo01', type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: APP('gestion-commerciale-entreprises'), dst: APP('orderhub'), type: 'calls', source: 'apm' });
  const matcher = createMatcher(PERIMETER, repo);
  let n = 0;
  const write = (over, ctx = {}) => {
    n++;
    const pageId = ctx.pageId || String(7000 + n);
    const doc = repo.upsertNode({ type: 'document', key: `confluence-${pageId}`, name: `Page ${pageId}`, source: 'confluence' });
    const f = { kind: 'incident', title: item('Titre'), section: null, date: null, fields: {}, lists: {}, appIds: [], serverIds: [], unresolved: [], tickets: [], keywords: [], replaces: null, fixes: null, ...over };
    return applyFiches(repo, { fiches: [f], rejected: [] }, { pageId, docNodeId: doc, page: { title: `Page ${pageId}`, url: `https://wiki.example.local/${pageId}`, updatedAt: ctx.updatedAt || '2026-10-01T10:00:00.000Z' }, period: ctx.period || 'current' }).fiches[0];
  };
  const search = (q, o = {}, sections = []) => searchKnowledge(buildKnowledgeIndex(repo, { sections }), repo, matcher, { query: q, ...o });
  return { repo, matcher, write, search };
}

describe('recherche des fiches', () => {
  test('error message finds the incident', () => {
    const w = world();
    const id = w.write({ title: item('File pleine'), fields: { symptoms: item('erreur Q.MRL.EVT saturee', 'la file Q.MRL.EVT est saturee') }, appIds: [APP('orderhub')] });
    w.write({ title: item('Autre sujet'), fields: { symptoms: item('rien a voir') } });
    const r = w.search('Message : la file Q.MRL.EVT est saturee depuis ce matin');
    assert.equal(r.fiches[0].id, id);
    assert.equal(r.fiches[0].kind, 'incident');
    assert.ok(r.fiches[0].excerpt.includes('Q.MRL.EVT'));
    assert.deepEqual(r.fiches[0].appNames, ['OrderHub']);
  });

  test('long pasted error keeps technical tokens', () => {
    const w = world();
    const id = w.write({ title: item('Snapshot trop vieux'), fields: { symptoms: item('ORA-01555 sur lmrlp01', 'ORA-01555 snapshot too old sur lmrlp01') } });
    w.write({ title: item('Bruit'), fields: { symptoms: item('exception generique java') } });
    const pile = Array.from({ length: 120 }, (_, i) => `\tat com.example.Service${i}.run(Service${i}.java:${i}) "x" /var/log/app/${i}.log`).join('\n');
    const r = w.search(`Exception in thread main java.lang.Error: ${pile}\nCaused by: ORA-01555: snapshot too old (host=lmrlp01) ${pile}`);
    assert.equal(r.fiches[0].id, id);
  });

  test('question app by sigle or typo', () => {
    const w = world();
    const mine = w.write({ title: item('Lenteur batch'), fields: { symptoms: item('lenteur du batch') }, appIds: [APP('gestion-commerciale-entreprises')] });
    const other = w.write({ title: item('Lenteur batch'), fields: { symptoms: item('lenteur du batch') }, appIds: [APP('solo')] });
    let r = w.search('lenteur du batch sur GCE');
    assert.deepEqual(r.apps, [APP('gestion-commerciale-entreprises')]);
    assert.equal(r.fiches[0].id, mine);
    const mar = w.write({ title: item('Lenteur batch'), fields: { symptoms: item('lenteur du batch') }, appIds: [APP('marelle')] });
    r = w.search('lenteur du batch sur Marele');
    assert.deepEqual(r.apps, [APP('marelle')]);
    assert.equal(r.fiches[0].id, mar);
    assert.ok(r.fiches.some((f) => f.id === other));
  });

  test('app fiches before neighbour fiches before others', () => {
    const w = world();
    const far = w.write({ title: item('Erreur export'), keywords: ['export'], appIds: [APP('solo')] });
    const near = w.write({ title: item('Erreur export'), keywords: ['export'], appIds: [APP('gestion-commerciale-entreprises')] });
    const own = w.write({ title: item('Erreur export'), keywords: ['export'], appIds: [APP('orderhub')] });
    const r = w.search('erreur export', { application: 'OrderHub' });
    assert.deepEqual(r.fiches.map((f) => f.id), [own, near, far]);
    assert.deepEqual(r.fiches.map((f) => f.otherApplication), [false, true, true]);
  });

  test('shared server makes a neighbour', () => {
    const w = world();
    const shared = w.write({ title: item('Disque plein'), appIds: [APP('marelle')] });
    const far = w.write({ title: item('Disque plein'), appIds: [APP('solo')] });
    const r = w.search('disque plein', { application: APP('orderhub') });
    assert.deepEqual(r.fiches.map((f) => f.id), [shared, far]);
  });

  test('recent procedure first, old one flagged', () => {
    const w = world();
    const old = w.write({ kind: 'procedure', title: item('Redemarrer le service'), appIds: [APP('orderhub')] }, { period: 'past', updatedAt: '2024-01-01T00:00:00.000Z' });
    const recent = w.write({ kind: 'procedure', title: item('Redemarrer le service'), appIds: [APP('orderhub')] }, { updatedAt: '2026-11-01T00:00:00.000Z' });
    const r = w.search('redemarrer le service');
    assert.deepEqual(r.fiches.map((f) => f.id), [recent, old]);
    assert.deepEqual(r.fiches.map((f) => f.old), [false, true]);
  });

  test('replaced procedure flagged and last', () => {
    const w = world();
    const oldP = w.write({ kind: 'procedure', title: item('Redemarrer OrderHub'), appIds: [APP('orderhub')] }, { updatedAt: '2025-03-01T00:00:00.000Z' });
    const newP = w.write({ kind: 'procedure', title: item('Redemarrer OrderHub en douceur'), replaces: item('Redemarrer OrderHub'), appIds: [APP('orderhub')] }, { updatedAt: '2026-03-01T00:00:00.000Z' });
    linkFiches(w.repo);
    const r = w.search('redemarrer OrderHub');
    assert.equal(r.fiches[r.fiches.length - 1].id, oldP);
    assert.equal(r.fiches[r.fiches.length - 1].replaced, true);
    assert.equal(r.fiches[0].id, newP);
    assert.equal(r.fiches[0].replaced, false);
  });

  test('incident and correctif never flagged old', () => {
    const w = world();
    w.write({ kind: 'incident', title: item('Panne ancienne portail') }, { period: 'past' });
    w.write({ kind: 'correctif', title: item('Correctif ancien portail') }, { period: 'past' });
    const r = w.search('ancien portail');
    assert.equal(r.fiches.length, 2);
    assert.ok(r.fiches.every((f) => f.old === false));
  });

  test('section hit when no fiche matches', () => {
    const w = world();
    w.write({ title: item('Sujet sans rapport') });
    const sections = [
      { pageId: '1', title: 'Page A', url: 'https://wiki.example.local/1', section: 'Reprise', text: 'Pour la reprise des traitements nocturnes, relancer le planificateur zeta.', period: 'current' },
      { pageId: '2', title: 'Page B', url: 'https://wiki.example.local/2', section: 'Divers', text: 'Rien.', period: 'current' },
    ];
    const r = w.search('relancer planificateur zeta', {}, sections);
    assert.deepEqual(r.fiches, []);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].pageId, '1');
    assert.ok(r.sections[0].excerpt.includes('zeta'));
  });

  test('empty index', () => {
    const w = world();
    const r = w.search('quelque chose');
    assert.deepEqual(r, { fiches: [], sections: [], apps: [] });
    assert.deepEqual(w.search('').fiches, []);
  });

  test('other application flagged', () => {
    const w = world();
    const mine = w.write({ title: item('Probleme certificat'), appIds: [APP('orderhub')] });
    const theirs = w.write({ title: item('Probleme certificat'), appIds: [APP('solo')] });
    const r = w.search('probleme certificat Solo');
    const by = Object.fromEntries(r.fiches.map((f) => [f.id, f.otherApplication]));
    assert.equal(by[theirs], false);
    assert.equal(by[mine], true);
    assert.equal(w.search('probleme certificat').fiches.every((f) => f.otherApplication === false), true);
  });

  test('retired fiche is never returned, getFiche gives the full fiche', () => {
    const w = world();
    const id = w.write({ title: item('Fiche complete'), fields: { symptoms: item('symptome', 'le symptome cite') }, appIds: [APP('orderhub')] });
    const f = getFiche(w.repo, id);
    assert.equal(f.fields.symptoms.evidence, 'le symptome cite');
    assert.deepEqual(f.appNames, ['OrderHub']);
    assert.equal(getFiche(w.repo, 'application:orderhub'), null);
    w.repo.patchNodeAttrs(id, { retired: true });
    assert.equal(getFiche(w.repo, id), null);
    assert.deepEqual(w.search('fiche complete').fiches, []);
  });
});

describe('routes de connaissance', () => {
  const build = () => {
    const w = world();
    const id = w.write({ title: item('Lenteur du portail'), keywords: ['lenteur'], appIds: [APP('orderhub')] });
    w.write({ kind: 'procedure', title: item('Vider le cache'), appIds: [APP('orderhub')] }, { updatedAt: '2026-11-02T00:00:00.000Z' });
    const app = createApp({ repo: w.repo, llm: null, config: null, matcher: w.matcher });
    return { w, id, app };
  };

  test('GET /api/knowledge/search', async () => {
    const { id, app } = build();
    const r = await request(app).get('/api/knowledge/search').query({ q: 'lenteur portail', app: 'OrderHub' }).expect(200);
    assert.equal(r.body.fiches[0].id, id);
    assert.deepEqual(r.body.apps, [APP('orderhub')]);
    assert.deepEqual((await request(app).get('/api/knowledge/search').expect(200)).body, { fiches: [], sections: [], apps: [] });
    const one = await request(app).get(`/api/knowledge/${encodeURIComponent(id)}`).expect(200);
    assert.equal(one.body.title, 'Lenteur du portail');
    await request(app).get('/api/knowledge/application:orderhub').expect(404);
    await request(app).get('/api/knowledge/fiche:nope-1').expect(404);
  });

  test('application detail lists its fiches', async () => {
    const { id, app } = build();
    const r = await request(app).get(`/api/applications/${encodeURIComponent(APP('orderhub'))}`).expect(200);
    assert.equal(r.body.knowledge.length, 2);
    assert.equal(r.body.knowledge[0].kind, 'procedure'); // plus récente d'abord
    assert.deepEqual(Object.keys(r.body.knowledge[0]).sort(), ['id', 'kind', 'old', 'period', 'replaced', 'title', 'updatedAt', 'url']);
    assert.ok(r.body.knowledge.some((k) => k.id === id));
    const other = await request(app).get(`/api/applications/${encodeURIComponent(APP('solo'))}`).expect(200);
    assert.deepEqual(other.body.knowledge, []);
  });
});
