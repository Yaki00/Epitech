'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createLlmClient } = require('../src/lib/llmClient');
const { loadPerimeter } = require('../src/perimeter/perimeter');
const { ingestInventory } = require('../src/ingest/inventory');
const { impactOf } = require('../src/graph/impact');
const { runConfluenceSync } = require('../src/reading/syncPages');
const { createReadingMock } = require('../src/reading/mockReadings');

const EXPORT = path.join(__dirname, 'fixtures', 'confluence-reading');
const READINGS = JSON.parse(fs.readFileSync(path.join(EXPORT, 'mock-readings.json'), 'utf8'));
const NOW = Date.parse('2026-11-23T12:00:00Z');
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const P1 = 'OrderHub - Architecture';
const P2 = 'OrderHub - Architecture 2018';
const P3 = "CR réunion d'équipe du 12/11";
const DOC = { [P1]: 'document:confluence-7001', [P2]: 'document:confluence-7002', [P3]: 'document:confluence-7003' };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-sync-'));
const titleOf = (body) => (String(body.messages[1].content).match(/^Titre : (.*)$/m) || [])[1];
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });

/** IA simulée : réponses préparées par titre ; `answer` peut être remplacé pour un passage. */
function fakeLlm() {
  const state = { calls: [], answer: (title) => READINGS[title] };
  const llm = createLlmClient(
    { mock: true, models: {}, concurrency: 2, maxRetries: 0, cacheDir: '' },
    {
      logger: silent,
      mockHandler: (endpoint, body) => {
        const title = titleOf(body);
        state.calls.push({ title, user: body.messages[1].content });
        const a = state.answer(title, body);
        return reply(typeof a === 'string' ? a : JSON.stringify(a));
      },
    }
  );
  return { llm, state };
}

function inventory(repo, hosts) {
  const mapping = { entity: 'server', key: 'Host', relations: [{ column: 'App', entity: 'application', type: 'runs_on', direction: 'from' }] };
  ingestInventory(repo, { source: 'apm', records: hosts.map((Host) => ({ App: 'OrderHub', Host })), mapping });
}

describe('analyse Confluence par lecture IA', () => {
  let repo;
  let perimeter;
  let reportsDir;
  let fake;
  const consignes1 = { text: 'Les serveurs commencent par srv.', hash: 'c1' };
  const run = (over = {}) =>
    runConfluenceSync({ repo, exportDir: EXPORT, llm: fake.llm, perimeter, consignes: consignes1, naemonHosts: [], reportsDir, now: NOW, log: silent, ...over });

  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'perimeter.json'), JSON.stringify({ applications: [{ name: 'OrderHub', aliases: ['ORH'] }] }));
    perimeter = loadPerimeter(path.join(dir, 'perimeter.json'));
    reportsDir = path.join(dir, 'rapports');
    inventory(repo, ['srvorh01']);
    fake = fakeLlm();
  });

  test('page kinds, past links out of impact, meeting without link', async () => {
    const r = await run();
    assert.equal(r.stats.read, 3);
    assert.equal(r.stats.errors, 0);
    assert.equal(fake.state.calls.length, 3);

    // nature de la page
    assert.equal(repo.getNode(DOC[P1]).attrs.pageKind, 'architecture');
    assert.equal(repo.getNode(DOC[P3]).attrs.pageKindAi, 'meeting');
    assert.equal(repo.getNode(DOC[P3]).attrs.pageKind, undefined);

    // page actuelle : serveur hors inventaire dit actif dans une page récente, compté dans l'impact
    const added = repo.edgesFrom('application:orderhub').find((e) => e.dst === 'server:srvnew01' && e.type === 'runs_on');
    assert.equal(added.attrs.trust, 'added');
    assert.ok(impactOf(repo, 'server:srvnew01').items.some((i) => i.id === 'application:orderhub'));
    // flèche draw.io qualifiée par l'IA, vérifiée sur la ligne du schéma
    assert.ok(repo.edgesFrom('application:orderhub').some((e) => e.type === 'uses_db' && e.dst === 'database:ora_orh'));
    // citation inventée : écartée
    assert.ok(!repo.getNode('server:srvfake09'));

    // page ancienne : lien gardé avec sa période, hors impact
    const old = repo.edgesFrom('application:orderhub').find((e) => e.dst === 'server:srvold01');
    assert.equal(old.attrs.period, 'past');
    assert.ok(!impactOf(repo, 'server:srvold01').items.some((i) => i.id === 'application:orderhub'));

    // réunion : rattachement « citée », aucun lien ni mention
    const fromP3 = repo.allEdges().filter((e) => e.sourceRef === '7003');
    assert.deepEqual(fromP3.map((e) => [e.type, e.attrs.role]), [['documented_in', 'cited']]);

    // document : lecture brute gardée, empreintes, statut
    const doc = repo.getDocument('confluence:7001');
    assert.equal(doc.status, 'enriched');
    assert.equal(doc.attrs.reading.page.kind, 'architecture');
    assert.ok(doc.attrs.readingHash);
    assert.deepEqual(doc.attrs.rejected, [{ what: 'srvfake09', reason: 'no_evidence' }]);
    // texte gardé pour le résumé seulement quand une application est sujet
    assert.ok(repo.getNode(DOC[P1]).attrs.excerpt);
    assert.equal(repo.getNode(DOC[P3]).attrs.excerpt, undefined);

    // rapports
    const pages = fs.readFileSync(path.join(reportsDir, 'perimetre-pages.csv'), 'utf8');
    assert.match(pages, /OrderHub;OrderHub - Architecture;[^;]*;sujet;OrderHub tourne sur srvorh01/);
    assert.match(pages, /CR réunion d'équipe du 12\/11;[^;]*;citée/);
    const rejects = fs.readFileSync(path.join(reportsDir, 'lectures-rejets.csv'), 'utf8');
    assert.match(rejects, /OrderHub - Architecture;srvfake09;citation absente de la page/);
    const spellings = fs.readFileSync(path.join(reportsDir, 'perimetre-orthographes.csv'), 'utf8');
    assert.match(spellings, /Ordrehub;OrderHub;1;/);
    assert.ok(!/\nOrderHub;/.test(spellings)); // le nom de référence n'est pas une orthographe à vérifier
    const archi = fs.readFileSync(path.join(reportsDir, 'architecture-pages.csv'), 'utf8');
    assert.match(archi, /OrderHub - Architecture;[^;]*;[^;]*;production \(PRD\)/);
  });

  test('second pass without change: no AI call', async () => {
    await run();
    fake.state.calls.length = 0;
    const r = await run();
    assert.equal(fake.state.calls.length, 0);
    assert.equal(r.stats.skipped, 3);
    assert.equal(r.stats.read, 0);
  });

  test('inventory changed: verification redone without AI', async () => {
    await run();
    fake.state.calls.length = 0;
    inventory(repo, ['srvorh01', 'srvnew01']);
    const r = await run();
    assert.equal(fake.state.calls.length, 0);
    assert.equal(r.stats.reverified, 3);
    // srvnew01 est maintenant dans l'inventaire de OrderHub : le lien de la lecture devient une confirmation
    const links = repo.edgesFrom('application:orderhub').filter((e) => e.dst === 'server:srvnew01' && e.type === 'runs_on');
    assert.deepEqual(links.map((e) => e.source), ['apm']);
    assert.equal(repo.getNode('server:srvnew01').attrs.outOfInventory, undefined);
  });

  test('naemon changed: verification redone without AI', async () => {
    await run();
    fake.state.calls.length = 0;
    const r = await run({ naemonHosts: ['srvnew01'] });
    assert.equal(fake.state.calls.length, 0);
    assert.equal(r.stats.reverified, 3);
  });

  test('consignes changed: pages read again; nodes no longer cited are retired', async () => {
    await run();
    fake.state.calls.length = 0;
    fake.state.answer = (title) => (title === P2 ? { ...READINGS[P2], entities: [], links: [] } : READINGS[title]);
    const r = await run({ consignes: { text: 'autre consigne', hash: 'c2' } });
    assert.equal(fake.state.calls.length, 3);
    assert.equal(r.stats.read, 3);
    const old = repo.getNode('server:srvold01');
    assert.equal(old.attrs.retired, true);
    assert.ok(old.attrs.retiredAt);
    assert.equal(r.stats.retired, 1);
    // nœud créé par une lecture et toujours cité : actif
    assert.ok(!repo.getNode('server:srvnew01').attrs.retired);
  });

  test('person cited only in an old page is not retired', async () => {
    const bruno = { name: 'Bruno Petit', kind: 'person', application: 'OrderHub', role: 'owner', evidence: "Responsable à l'époque : Bruno Petit" };
    fake.state.answer = (title) => (title === P2 ? { ...READINGS[P2], owners: [bruno] } : READINGS[title]);
    const r = await run();
    const owned = repo.edgesFrom('application:orderhub').find((e) => e.type === 'owned_by' && e.dst === 'person:bruno-petit');
    assert.equal(owned.attrs.period, 'past'); // lien inactif : montré comme ancien par l'API
    const person = repo.getNode('person:bruno-petit');
    assert.equal(person.attrs.fromLlm, true);
    assert.equal(person.attrs.retired, undefined);
    assert.equal(r.stats.retired, 0);
  });

  test('chunk failure: page in error, previous reading kept', async () => {
    await run();
    const before = repo.getDocument('confluence:7001');
    const edgesBefore = repo.allEdges().filter((e) => e.sourceRef === '7001').length;
    fake.state.calls.length = 0;
    // le 2e morceau de la page 1 revient vide (deux fois : la nouvelle tentative aussi)
    fake.state.answer = (title, body) => (title === P1 && /Morceau 2 sur/.test(body.messages[1].content) ? '' : READINGS[title]);
    const r = await run({ consignes: { text: 'autre consigne', hash: 'c3' }, chunkChars: 250 });
    assert.equal(r.stats.errors, 1);
    assert.equal(r.status, 'partial');
    const doc = repo.getDocument('confluence:7001');
    assert.equal(doc.status, 'error');
    assert.match(doc.error, /vide/);
    assert.deepEqual(doc.attrs.reading, before.attrs.reading);
    assert.equal(doc.attrs.readingHash, before.attrs.readingHash);
    assert.equal(repo.allEdges().filter((e) => e.sourceRef === '7001').length, edgesBefore);
    assert.equal(repo.getDocument('confluence:7002').status, 'enriched');
    assert.ok(repo.errorsOfRun(r.runId).some((e) => e.ref === '7001' && e.step === 'llm'));

    // passage suivant : seule la page en erreur repart à l'IA
    fake.state.calls.length = 0;
    fake.state.answer = (title) => READINGS[title];
    const again = await run({ consignes: { text: 'autre consigne', hash: 'c3' } });
    assert.deepEqual([...new Set(fake.state.calls.map((c) => c.title))], [P1]);
    assert.equal(again.stats.read, 1);
    assert.equal(repo.getDocument('confluence:7001').status, 'enriched');
  });

  test('without AI: pages stored, nothing deduced', async () => {
    const r = await run({ llm: null });
    assert.equal(r.stats.pages, 3);
    assert.equal(r.stats.notRead, 3);
    assert.ok(repo.getNode(DOC[P1]));
    assert.equal(repo.allEdges().filter((e) => ['7001', '7002', '7003'].includes(e.sourceRef)).length, 0);
    assert.equal(repo.getDocument('confluence:7001').status, 'parsed');
  });

  test('reading mock answers from prepared readings by title', async () => {
    const handler = createReadingMock(READINGS);
    const body = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: `Titre : ${P3}\nPages parentes : (aucune)` }] };
    assert.equal(JSON.parse(handler('/chat/completions', body).choices[0].message.content).page.kind, 'meeting');
    const unknown = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Titre : Inconnue' }] };
    assert.equal(JSON.parse(handler('/chat/completions', unknown).choices[0].message.content).page.kind, 'other');
  });
});
