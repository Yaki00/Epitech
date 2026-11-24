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
const { readExportPages, exportHash } = require('../src/ingest/confluenceExport');

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
    // serveur créé par la lecture et seulement cité comme arrêté : retiré (la citation ne le garde pas actif)
    assert.equal(repo.getNode('server:srvold01').attrs.retired, true);
    const mention = repo.edgesTo('server:srvold01').find((e) => e.type === 'mentions');
    assert.deepEqual(mention.attrs, { status: 'decommissioned', period: 'past' });
    assert.equal(r.stats.retired, 1);

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
    // la page ne dit pas son environnement dans son titre : pas d'environnement
    assert.match(archi, /OrderHub - Architecture;[^;]*;[^;]*;;/);
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

  test('audit expected and missing are identical after a re-verify', async () => {
    const audits = () =>
      repo
        .edgesFrom('application:orderhub')
        .filter((e) => e.type === 'documented_in' && e.attrs.audit)
        .map((e) => [e.dst, e.attrs.audit.expected, e.attrs.audit.missing, e.attrs.audit.confirmed, e.attrs.audit.unknown])
        .sort();
    await run();
    const first = audits();
    const r = await run({ naemonHosts: ['srvautre99'] });
    assert.equal(r.stats.reverified, 3);
    assert.deepEqual(audits(), first);
    // la référence de l'audit reste l'inventaire : le serveur ajouté par la lecture n'y entre pas
    const p1 = first.find((a) => a[0] === DOC[P1]);
    assert.equal(p1[1], 1);
    assert.deepEqual(p1[4], ['srvnew01']);
  });

  test('consignes changed: pages read again; nodes no longer cited are retired', async () => {
    await run();
    fake.state.calls.length = 0;
    const p1 = READINGS[P1];
    const withoutNew = { ...p1, entities: p1.entities.filter((e) => e.name !== 'srvnew01'), links: p1.links.filter((l) => l.to !== 'srvnew01') };
    fake.state.answer = (title) => (title === P1 ? withoutNew : READINGS[title]);
    const r = await run({ consignes: { text: 'autre consigne', hash: 'c2' } });
    assert.equal(fake.state.calls.length, 3);
    assert.equal(r.stats.read, 3);
    const gone = repo.getNode('server:srvnew01');
    assert.equal(gone.attrs.retired, true);
    assert.ok(gone.attrs.retiredAt);
    assert.equal(r.stats.retired, 1);
    // base créée par une lecture et toujours citée : active
    assert.ok(!repo.getNode('database:ora_orh').attrs.retired);
  });

  test('quote that does not name the item: rejected, counted and reported', async () => {
    const ghost = { name: 'srvghost42', type: 'server', env: 'PRD', ip: null, status: 'active', evidence: 'OrderHub tourne sur srvorh01' };
    fake.state.answer = (title) => (title === P1 ? { ...READINGS[P1], entities: [...READINGS[P1].entities, ghost] } : READINGS[title]);
    const r = await run();
    assert.ok(!repo.getNode('server:srvghost42'));
    assert.equal(r.stats.evidenceMismatch, 1);
    assert.equal(r.stats.rejected, 2); // srvfake09 (citation absente) et srvghost42
    const rejects = fs.readFileSync(path.join(reportsDir, 'lectures-rejets.csv'), 'utf8');
    assert.match(rejects, /OrderHub - Architecture;srvghost42;citation qui ne nomme pas l'élément/);
  });

  test('new year: only pages whose reading is past or target (page or link) are read again', async () => {
    await run();
    fake.state.calls.length = 0;
    const r = await run({ now: Date.parse('2027-01-05T12:00:00Z') });
    assert.deepEqual(fake.state.calls.map((c) => c.title), [P2]);
    assert.equal(r.stats.read, 1);
    assert.equal(r.stats.reverified, 2);
    assert.equal(repo.getDocument('confluence:7002').attrs.readingYear, 2027);
    assert.equal(repo.getDocument('confluence:7001').attrs.readingYear, 2026);
    // même année ensuite : plus rien à relire
    fake.state.calls.length = 0;
    await run({ now: Date.parse('2027-01-20T12:00:00Z') });
    assert.equal(fake.state.calls.length, 0);
  });

  test('the date of the day is sent to the model but is not a valid quote', async () => {
    const dated = { name: 'OrderHub', written: 'OrderHub', role: 'cited', evidence: 'Date du jour : 2026-11-23' };
    fake.state.answer = (title) => (title === P3 ? { ...READINGS[P3], applications: [dated] } : READINGS[title]);
    await run();
    assert.ok(fake.state.calls.every((c) => c.user.includes('Date du jour : 2026-11-23')));
    assert.deepEqual(repo.getDocument('confluence:7003').attrs.rejected, [{ what: 'OrderHub', reason: 'no_evidence' }]);
    assert.ok(!repo.edgesFrom('application:orderhub').some((e) => e.type === 'documented_in' && e.dst === DOC[P3]));
  });

  test('page env is kept only when the title or the parent pages write it', async () => {
    const withEnv = (envEvidence) => ({ ...READINGS[P1], page: { ...READINGS[P1].page, env: 'PRD', envEvidence } });
    // section « Serveurs de production » de la page : refusée
    fake.state.answer = (title) => (title === P1 ? withEnv('Serveurs de production') : READINGS[title]);
    await run();
    const audit = () => repo.edgesFrom('application:orderhub').find((x) => x.type === 'documented_in' && x.dst === DOC[P1]).attrs.audit;
    assert.equal(audit().environment, null);
    assert.ok(repo.getDocument('confluence:7001').attrs.rejected.some((r) => r.what === 'environnement de la page (PRD)' && r.reason === 'not_in_header'));
    const rejects = fs.readFileSync(path.join(reportsDir, 'lectures-rejets.csv'), 'utf8');
    assert.match(rejects, /environnement de la page \(PRD\);environnement absent du titre et des pages parentes/);
    // le titre ne le dit pas non plus : seule une page dont le titre ou les parents le disent le garde (voir verify.test.js)
    fake.state.answer = (title) => (title === P1 ? withEnv('OrderHub - Architecture') : READINGS[title]);
    await run({ force: true });
    assert.equal(audit().environment, null);
  });

  test('a quote of the header line sent to the model (« Titre : X ») is accepted', async () => {
    const subject = { name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: `Titre : ${P1}` };
    fake.state.answer = (title) => (title === P1 ? { ...READINGS[P1], applications: [subject] } : READINGS[title]);
    await run();
    // l'en-tête envoyé est bien celui contrôlé
    assert.ok(fake.state.calls.some((c) => c.user.includes(`Titre : ${P1}`)));
    const e = repo.edgesFrom('application:orderhub').find((x) => x.type === 'documented_in' && x.dst === DOC[P1]);
    assert.equal(e.attrs.role, 'subject');
    assert.ok(e.attrs.audit);
    assert.ok(!repo.getDocument('confluence:7001').attrs.rejected.some((r) => r.what === 'OrderHub'));
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
    assert.equal(r.stats.retired, 1); // seulement srvold01, cité comme arrêté
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

  test('without AI: outputs of the old rules are purged from pages never read', async () => {
    // état laissé par l'ancienne analyse (règles) : page déjà traitée, contenu inchangé
    const entry = [...readExportPages(EXPORT)].find((e) => e.p && e.p.id === '7001');
    repo.upsertNode({ type: 'document', key: 'confluence-7001', name: P1, source: 'confluence', attrs: { pageKind: 'architecture', architecture: { score: 0.8 } } });
    repo.upsertNode({ type: 'database', key: 'ORA_ORH', name: 'ORA_ORH', source: 'llm' });
    repo.addEdge({ src: DOC[P1], dst: 'server:srvorh01', type: 'mentions', source: 'confluence', sourceRef: '7001' });
    repo.addEdge({ src: 'application:orderhub', dst: DOC[P1], type: 'documented_in', source: 'confluence', sourceRef: '7001', confidence: 0.8 });
    repo.addEdge({ src: 'application:orderhub', dst: 'database:ora_orh', type: 'uses_db', source: 'drawio', sourceRef: '7001' });
    repo.addEdge({ src: 'application:orderhub', dst: 'database:ora_orh', type: 'uses_db', source: 'llm', sourceRef: '7001' });
    repo.saveDocument({ id: 'confluence:7001', source: 'confluence', title: P1, contentHash: exportHash(entry), status: 'parsed', attrs: {} });

    const r = await run({ llm: null });
    assert.equal(repo.allEdges().filter((e) => e.sourceRef === '7001').length, 0);
    assert.equal(repo.getNode(DOC[P1]).attrs.pageKind, undefined);
    assert.equal(repo.getNode(DOC[P1]).attrs.architecture, undefined);
    // les liens des inventaires ne sont jamais touchés
    assert.ok(repo.edgesFrom('application:orderhub').some((e) => e.type === 'runs_on' && e.source === 'apm'));
    assert.equal(r.stats.notRead, 3);
    // passage suivant sans IA : rien à refaire, pages comptées « non lues » et jamais aussi « inchangées »
    const again = await run({ llm: null });
    assert.equal(again.stats.notRead, 3);
    assert.equal(again.stats.skipped, 0);
    assert.equal(again.stats.pages, 0);
  });

  test('verify or apply failure: recorded with its step, no unhandled rejection', async () => {
    const warns = [];
    const log = { ...silent, warn: (m) => warns.push(m), error: (m) => warns.push(m) };
    // vérification en échec (bogue simulé) : rien n'est écrit, lecture précédente gardée
    const broken = { ...repo, resolve: () => { throw new Error('boom verify'); } };
    let r = await run({ repo: broken, log });
    let steps = repo.errorsOfRun(r.runId).map((e) => [e.ref, e.step]).sort();
    assert.deepEqual(steps, [['7001', 'verify'], ['7002', 'verify']]);
    assert.equal(repo.getDocument('confluence:7001').status, 'error');
    assert.ok(warns.some((m) => /7001/.test(m) && /vérification/.test(m)));

    // écriture en échec après la purge : le journal ne prétend pas que la lecture précédente est gardée
    warns.length = 0;
    const failing = { ...repo, patchNodeAttrs: (id, patch) => { if ('pageKindAi' in patch) throw new Error('boom apply'); return repo.patchNodeAttrs(id, patch); } };
    r = await run({ repo: failing, log, consignes: { text: 'x', hash: 'c9' } });
    steps = repo.errorsOfRun(r.runId).map((e) => e.step);
    assert.deepEqual([...new Set(steps)], ['apply']);
    assert.equal(r.status, 'partial');
    assert.ok(warns.length && warns.every((m) => !/lecture précédente gardée/.test(m)));
  });

  test('reading mock answers from prepared readings by title', async () => {
    const handler = createReadingMock(READINGS);
    const body = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: `Titre : ${P3}\nPages parentes : (aucune)` }] };
    assert.equal(JSON.parse(handler('/chat/completions', body).choices[0].message.content).page.kind, 'meeting');
    const unknown = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Titre : Inconnue' }] };
    assert.equal(JSON.parse(handler('/chat/completions', unknown).choices[0].message.content).page.kind, 'other');
  });
});

describe('fin de passage : pages dont un lien est resté à valider revues sans IA', () => {
  const page = (dir, folder, meta, html) => {
    const d = path.join(dir, 'ESP', folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'metadata.json'), JSON.stringify({ spaceKey: 'ESP', updatedAt: '2026-06-01T10:00:00.000+02:00', version: 1, ancestors: [{ id: '1', title: 'Accueil' }], url: `https://wiki.example.local/${meta.pageId}`, ...meta }));
    fs.writeFileSync(path.join(d, 'page.html'), html);
  };
  const A = 'OrderHub - Bases';
  const B = 'Billing - Architecture';
  const readings = {
    // lue en premier : la base BILREF (de Billing) est hébergée sur srvbil01 (serveur de Billing)
    [A]: {
      page: { kind: 'architecture', period: 'current', env: null, topics: ['databases'] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub lit la base BILREF' }],
      entities: [
        { name: 'BILREF', type: 'database', status: 'active', evidence: 'La base BILREF est hébergée sur srvbil01' },
        { name: 'srvbil01', type: 'server', status: 'active', evidence: 'La base BILREF est hébergée sur srvbil01' },
      ],
      links: [
        { from: 'OrderHub', to: 'BILREF', type: 'reads_from', evidence: 'OrderHub lit la base BILREF' },
        { from: 'BILREF', to: 'srvbil01', type: 'db_on', evidence: 'La base BILREF est hébergée sur srvbil01' },
      ],
      owners: [],
    },
    // lue ensuite : c'est elle qui dit que BILREF est la base de Billing
    [B]: {
      page: { kind: 'architecture', period: 'current', env: null, topics: ['databases'] },
      applications: [{ name: 'Billing', written: 'Billing', role: 'subject', evidence: 'Billing utilise la base BILREF' }],
      entities: [{ name: 'BILREF', type: 'database', status: 'active', evidence: 'Billing utilise la base BILREF' }],
      links: [{ from: 'Billing', to: 'BILREF', type: 'uses_db', evidence: 'Billing utilise la base BILREF' }],
      owners: [],
    },
  };

  test('db_on to the server of the application that owns the database is added even when that page is read later', async () => {
    const dir = tmp();
    const exportDir = path.join(dir, 'export');
    page(exportDir, '0001 - A', { pageId: '7101', title: A }, '<p>OrderHub lit la base BILREF.</p><p>La base BILREF est hébergée sur srvbil01.</p>');
    page(exportDir, '0002 - B', { pageId: '7102', title: B }, '<p>Billing utilise la base BILREF.</p>');
    fs.writeFileSync(path.join(dir, 'perimeter.json'), JSON.stringify({ applications: [{ name: 'OrderHub' }, { name: 'Billing' }] }));
    const repo = createRepo(openStore(':memory:'));
    const mapping = { entity: 'server', key: 'Host', relations: [{ column: 'App', entity: 'application', type: 'runs_on', direction: 'from' }] };
    ingestInventory(repo, { source: 'apm', records: [{ App: 'OrderHub', Host: 'srvorh01' }, { App: 'Billing', Host: 'srvbil01' }], mapping });
    const calls = [];
    const llm = createLlmClient(
      { mock: true, models: {}, concurrency: 1, maxRetries: 0, cacheDir: '' },
      { logger: silent, mockHandler: (endpoint, body) => (calls.push(titleOf(body)), reply(JSON.stringify(readings[titleOf(body)]))) }
    );
    // une page à la fois, dans l'ordre de l'export : A est vérifiée avant que B ait écrit « Billing uses_db BILREF »
    const r = await runConfluenceSync({ repo, exportDir, llm, perimeter: loadPerimeter(path.join(dir, 'perimeter.json')), naemonHosts: [], now: NOW, log: silent, maxInFlight: 1 });
    assert.deepEqual(calls, [A, B]);
    const dbOn = repo.edgesFrom('database:bilref').find((e) => e.type === 'db_on');
    assert.equal(dbOn.attrs.trust, 'added');
    assert.equal(r.stats.toValidate, 0);
    assert.equal(r.stats.read, 2);
    assert.equal(r.stats.links, 3);
    assert.ok(impactOf(repo, 'server:srvbil01').items.some((i) => i.id === 'application:orderhub'));
  });
});

describe('serveur hors inventaire dit arrêté par une autre page', () => {
  const SRV = 'server:srvold77';
  const pages = {
    'OrderHub - Serveurs': { id: '8001', updatedAt: '2026-06-01T09:00:00.000+02:00', html: '<p>OrderHub tourne sur srvold77.</p>' },
    'CR atelier supervision': { id: '8002', updatedAt: '2026-10-01T09:00:00.000+02:00', html: '<p>Le serveur srvold77 est arrêté depuis mars.</p>' },
  };
  const readings = {
    'OrderHub - Serveurs': {
      page: { kind: 'architecture', period: 'current', topics: ['servers'] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub tourne sur srvold77' }],
      entities: [{ name: 'srvold77', type: 'server', status: 'active', evidence: 'OrderHub tourne sur srvold77' }],
      links: [{ from: 'OrderHub', to: 'srvold77', type: 'runs_on', evidence: 'OrderHub tourne sur srvold77' }],
      owners: [],
    },
    'CR atelier supervision': {
      page: { kind: 'meeting', period: 'current', topics: [] },
      applications: [],
      entities: [{ name: 'srvold77', type: 'server', status: 'decommissioned', evidence: 'Le serveur srvold77 est arrêté depuis mars' }],
      links: [],
      owners: [],
    },
  };
  function writePage(dir, title) {
    const p = pages[title];
    const d = path.join(dir, 'ESP', `${p.id} - ${title}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'metadata.json'), JSON.stringify({ pageId: p.id, title, url: `https://wiki.example.local/pages/${p.id}`, spaceKey: 'ESP', updatedAt: p.updatedAt, version: 1, ancestors: [{ id: '1', title: 'Accueil' }] }));
    fs.writeFileSync(path.join(d, 'page.html'), p.html);
  }
  let repo;
  let perimeter;
  let fake;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'perimeter.json'), JSON.stringify({ applications: [{ name: 'OrderHub' }] }));
    perimeter = loadPerimeter(path.join(dir, 'perimeter.json'));
    inventory(repo, ['srvorh01']);
    fake = fakeLlm();
    fake.state.answer = (title) => readings[title];
  });
  const run = (exportDir) => runConfluenceSync({ repo, exportDir, llm: fake.llm, perimeter, naemonHosts: ['srvold77'], reportsDir: null, now: NOW, log: silent });
  const trust = () => repo.edgesTo(SRV).find((e) => e.type === 'runs_on').attrs.trust;

  test('a page read later in the same pass that says the server is stopped: the link goes to validate', async () => {
    const dir = tmp();
    writePage(dir, 'OrderHub - Serveurs');
    writePage(dir, 'CR atelier supervision');
    await run(dir);
    assert.equal(trust(), 'toValidate');
    // passage suivant sans changement : rien n'est relu ni revérifié
    const again = await run(dir);
    assert.deepEqual([again.stats.skipped, again.stats.reverified, again.stats.read], [2, 0, 0]);
  });

  test('a page added later: the other pages are verified again, without AI, at the next pass', async () => {
    const dir = tmp();
    writePage(dir, 'OrderHub - Serveurs');
    await run(dir);
    assert.equal(trust(), 'added');
    writePage(dir, 'CR atelier supervision');
    await run(dir);
    const calls = fake.state.calls.length;
    const third = await run(dir);
    assert.equal(fake.state.calls.length, calls);
    assert.equal(third.stats.reverified, 1);
    assert.equal(trust(), 'toValidate');
  });
});
