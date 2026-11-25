'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { hasEvidence } = require('../src/reading/evidence');
const { verifyReading } = require('../src/reading/verify');

const DAY = 86400000;
const NOW = Date.parse('2026-11-23T10:00:00Z');
const RECENT = new Date(NOW - 30 * DAY).toISOString();
const OLD = new Date(NOW - 30 * 30 * DAY).toISOString();

function makePerimeter(ignoreOtherApplications = true) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-verify-')), 'perimeter.json');
  fs.writeFileSync(file, JSON.stringify({ ignoreOtherApplications, applications: [{ name: 'OrderHub', aliases: ['ORH'] }, { name: 'Billing Engine' }] }));
  return loadPerimeter(file);
}

function setup(ignoreOthers = true) {
  const repo = createRepo(openStore(':memory:'));
  const perimeter = makePerimeter(ignoreOthers);
  ensurePerimeterNodes(repo, perimeter);
  const srv = (name, extra = {}, aliases = []) => repo.upsertNode({ type: 'server', key: name, name, source: 'apm', attrs: { environment: 'PRD', ...extra }, aliases });
  const s1 = srv('srvorh01', {}, ['10.0.0.1', 'srvorh01.corp.example']);
  const s2 = srv('srvbil01');
  repo.addEdge({ src: 'application:orderhub', dst: s1, type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: 'application:billing-engine', dst: s2, type: 'runs_on', source: 'apm' });
  const matcher = createMatcher(perimeter, repo);
  return { repo, matcher, s1, s2 };
}

const reading = (over = {}) => ({
  page: { kind: 'architecture', period: 'current', env: null, topics: [] },
  applications: [], entities: [], links: [], owners: [], ...over,
});
const ctxOf = (env, over = {}) => ({ pageText: '', diagramsText: '', repo: env.repo, matcher: env.matcher, naemonHosts: new Set(), pageUpdatedAt: RECENT, now: NOW, ...over });
const runsOn = (to, evidence, over = {}) => ({ from: 'OrderHub', to, type: 'runs_on', evidence, ...over });
const server = (name, evidence, over = {}) => ({ name, type: 'server', env: null, status: 'active', evidence, ...over });

describe('hasEvidence', () => {
  test('evidence tolerates quotes, nbsp, line breaks and table pipes', () => {
    assert.ok(hasEvidence("L’application tourne sur SRVORH01 | PRD", "l'application tourne sur srvorh01 prd"));
    assert.ok(hasEvidence('Serveur :\nsrvorh01', 'Serveur : srvorh01'));
    assert.ok(hasEvidence('« Base de données » du Système', '"base de donnees" du systeme'));
    assert.ok(hasEvidence('srvorh01 | PRD | actif', 'srvorh01 PRD actif'));
    assert.ok(!hasEvidence('texte', ''));
    assert.ok(hasEvidence('A → B (lien)', 'a -> b (lien)'));
    assert.ok(hasEvidence('pré\u2011prod', 'pré-prod'));
  });

  test('the account before the @ of an address is ignored on both sides', () => {
    assert.ok(hasEvidence('ssh deploy@srv01.rec.corp.example', 'ssh srv01.rec.corp.example'));
    assert.ok(hasEvidence('ssh deploy@srv01.rec.corp.example', 'ssh deploy@srv01.rec.corp.example'));
    assert.ok(hasEvidence('db.url=jdbc:oracle:thin:@ora01.corp.example:1521/DB', 'thin:@ora01.corp.example:1521'));
    assert.ok(!hasEvidence('ssh deploy@srv01.rec.corp.example', 'ssh srv02.rec.corp.example'));
  });

  test('too short evidence is rejected', () => {
    assert.ok(!hasEvidence('abc srv 12', 'srv'));
    assert.ok(!hasEvidence('a | b ... c', '...'));
  });
});

describe('verifyReading', () => {
  test('resolves fqdn, short name and ip', () => {
    const env = setup();
    const text = 'srvorh01.CORP.example 10.0.0.1 SRVORH01';
    const r = reading({
      entities: [server('SRVORH01.corp.example', 'srvorh01.CORP.example'), { name: '10.0.0.1', type: 'ip', env: null, status: 'active', evidence: '10.0.0.1' }, server('SRVORH01', 'SRVORH01')],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: text }));
    assert.deepEqual(v.rejected, []);
    assert.equal(v.servers.length, 1);
    assert.equal(v.servers[0].nodeId, env.s1);
    assert.equal(v.servers[0].inInventory, true);
  });

  test('invented evidence is rejected', () => {
    const env = setup();
    const r = reading({
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub est ici' }, { name: 'ORH', written: 'ORH', role: 'cited', evidence: 'phrase inventée' }],
      links: [runsOn('srvorh01', 'jamais écrit')],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'OrderHub est ici srvorh01' }));
    assert.equal(v.apps.length, 1);
    assert.equal(v.links.length, 0);
    assert.deepEqual(v.rejected.map((x) => x.reason), ['no_evidence', 'no_evidence']);
  });

  test('evidence from diagram text is accepted', () => {
    const env = setup();
    const r = reading({ links: [runsOn('srvorh01', 'Schéma Flux : OrderHub → srvorh01 (hébergé)')] });
    const v = verifyReading(r, ctxOf(env, { diagramsText: 'Schéma Flux : OrderHub → srvorh01 (hébergé)' }));
    assert.equal(v.links[0].trust, 'confirmed');
  });

  test('inventory server of the right app is confirmed', () => {
    const env = setup();
    const v = verifyReading(reading({ links: [runsOn('srvorh01', 'tourne sur srvorh01')] }), ctxOf(env, { pageText: 'OrderHub tourne sur srvorh01' }));
    assert.deepEqual(v.links.map((l) => [l.src, l.dst, l.trust, l.period]), [['application:orderhub', env.s1, 'confirmed', 'current']]);
  });

  test('server of another app gives otherApp and no link', () => {
    const env = setup();
    const v = verifyReading(reading({ links: [runsOn('srvbil01', 'sur srvbil01')] }), ctxOf(env, { pageText: 'OrderHub sur srvbil01' }));
    assert.equal(v.links.length, 1);
    assert.equal(v.links[0].trust, 'otherApp');
  });

  test('unknown server supervised by naemon is added', () => {
    const env = setup();
    const r = reading({ entities: [server('srvnew01', 'srvnew01')], links: [runsOn('srvnew01', 'sur srvnew01')] });
    const v = verifyReading(r, ctxOf(env, { pageText: 'OrderHub sur srvnew01', naemonHosts: new Set(['srvnew01']), pageUpdatedAt: OLD }));
    assert.equal(v.links[0].trust, 'added');
    assert.equal(v.servers[0].nodeId, null);
    assert.equal(v.servers[0].inInventory, false);
    assert.equal(v.servers[0].corroborated, true);
  });

  test('unknown server on a recent current page is added, on a 30-month-old page is toValidate', () => {
    const env = setup();
    const r = reading({ entities: [server('srvnew01', 'srvnew01')], links: [runsOn('srvnew01', 'sur srvnew01')] });
    const base = { pageText: 'OrderHub sur srvnew01' };
    const recent = verifyReading(r, ctxOf(env, base));
    assert.equal(recent.links[0].trust, 'added');
    assert.equal(recent.servers[0].corroborated, true);
    const old = verifyReading(r, ctxOf(env, { ...base, pageUpdatedAt: OLD }));
    assert.equal(old.links[0].trust, 'toValidate');
    assert.equal(old.servers[0].corroborated, false);
    const noDate = verifyReading(r, ctxOf(env, { ...base, pageUpdatedAt: null }));
    assert.equal(noDate.links[0].trust, 'toValidate');
  });

  test('decommissioned server gives past period', () => {
    const env = setup();
    const r = reading({ entities: [server('srvorh01', 'srvorh01', { status: 'decommissioned' })], links: [runsOn('srvorh01', 'srvorh01')] });
    const v = verifyReading(r, ctxOf(env, { pageText: 'OrderHub srvorh01' }));
    assert.equal(v.links[0].period, 'past');
    const p = verifyReading(reading({ entities: [server('srvorh01', 'srvorh01', { status: 'planned' })], links: [runsOn('srvorh01', 'srvorh01')] }), ctxOf(env, { pageText: 'OrderHub srvorh01' }));
    assert.equal(p.links[0].period, 'target');
  });

  test('target page gives target period for every link', () => {
    const env = setup();
    const r = reading({
      page: { kind: 'architecture', period: 'target', env: null, topics: [] },
      links: [runsOn('srvorh01', 'srvorh01'), { from: 'OrderHub', to: 'Billing Engine', type: 'calls', evidence: 'appelle Billing Engine' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'srvorh01 appelle Billing Engine', headerText: 'Titre : OrderHub : architecture cible' }));
    assert.deepEqual(v.links.map((l) => l.period), ['target', 'target']);
    const past = verifyReading({ ...r, page: { ...r.page, period: 'past' } }, ctxOf(env, { pageText: 'srvorh01 appelle Billing Engine', headerText: 'Titre : DAT OrderHub (obsolète)' }));
    assert.deepEqual(past.links.map((l) => l.period), ['past', 'past']);
  });

  test('document links are added with the page period', () => {
    const env = setup();
    const r = reading({
      entities: [{ name: 'DB_ORDERS', type: 'database', env: null, status: 'active', evidence: 'DB_ORDERS' }],
      links: [{ from: 'ORH', to: 'Billing Engine', type: 'calls', evidence: 'ORH appelle Billing' }, { from: 'OrderHub', to: 'DB_ORDERS', type: 'uses_db', evidence: 'base DB_ORDERS' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'ORH appelle Billing, base DB_ORDERS' }));
    assert.deepEqual(v.links.map((l) => [l.type, l.trust, l.period]), [['calls', 'added', 'current'], ['uses_db', 'added', 'current']]);
    assert.equal(v.links[0].src, 'application:orderhub');
    assert.equal(v.links[0].dst, 'application:billing-engine');
    assert.equal(v.links[1].dstName, 'DB_ORDERS');
  });

  test('server ip from the reading is carried to Verified', () => {
    const env = setup();
    const r = reading({ entities: [server('srvorh01', 'srvorh01 10.0.0.9', { ip: '10.0.0.9' })] });
    const v = verifyReading(r, ctxOf(env, { pageText: 'srvorh01 10.0.0.9' }));
    assert.equal(v.servers[0].ip, '10.0.0.9');
  });

  test('applications outside the perimeter are out_of_scope', () => {
    const env = setup();
    const r = reading({ applications: [{ name: 'Inconnue', written: 'Inconnue', role: 'cited', evidence: 'Inconnue' }] });
    const v = verifyReading(r, ctxOf(env, { pageText: 'Inconnue' }));
    assert.deepEqual(v.rejected, [{ what: 'Inconnue', reason: 'out_of_scope' }]);
    const open = setup(false);
    const w = verifyReading(r, ctxOf(open, { pageText: 'Inconnue' }));
    assert.equal(w.apps.length, 1);
    assert.equal(w.apps[0].appId, 'application:inconnue');
  });

  test('owners keep role and period', () => {
    const env = setup();
    const r = reading({
      page: { kind: 'operations', period: 'past', env: null, topics: [] },
      owners: [
        { name: 'Awa Diallo', kind: 'person', application: 'ORH', role: 'oncall', evidence: 'Awa Diallo astreinte' },
        { name: 'Equipe X', kind: 'team', application: 'Zzz', role: 'support', evidence: 'Equipe X' },
        { name: 'Sans', kind: 'person', application: null, role: 'owner', evidence: 'Sans' },
      ],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'Awa Diallo astreinte. Equipe X. Sans', headerText: 'Titre : Astreintes (archivée)' }));
    assert.deepEqual(v.owners, [{ appId: 'application:orderhub', name: 'Awa Diallo', kind: 'person', role: 'oncall', period: 'past', evidence: 'Awa Diallo astreinte' }]);
    assert.deepEqual(v.rejected.map((x) => x.reason), ['unknown_application', 'unknown_application']);
  });

  test('null page period makes non-confirmed links toValidate', () => {
    const env = setup();
    const r = reading({
      page: { kind: 'architecture', period: null, env: null, topics: [] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub' }],
      links: [runsOn('srvorh01', 'srvorh01'), { from: 'OrderHub', to: 'Billing Engine', type: 'calls', evidence: 'Billing Engine' }],
      owners: [{ name: 'Awa', kind: 'person', application: 'ORH', role: 'owner', evidence: 'Awa Diallo' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'OrderHub srvorh01 Billing Engine Awa Diallo' }));
    assert.deepEqual(v.links.map((l) => l.trust), ['confirmed', 'toValidate']);
    assert.equal(v.apps.length, 1);
    assert.equal(v.owners[0].period, null); // période inconnue : jamais comptée comme actuelle
  });

  test('null server status makes its link toValidate', () => {
    const env = setup();
    const r = reading({ entities: [server('srvnew01', 'srvnew01', { status: null }), server('srvorh01', 'srvorh01', { status: null })], links: [runsOn('srvnew01', 'srvnew01'), runsOn('srvorh01', 'srvorh01')] });
    const v = verifyReading(r, ctxOf(env, { pageText: 'srvnew01 srvorh01', naemonHosts: new Set(['srvnew01']) }));
    assert.deepEqual(v.links.map((l) => l.trust), ['toValidate', 'confirmed']);
  });

  test('server node created by documentation only is not in inventory and can be corroborated by naemon', () => {
    const env = setup();
    env.repo.upsertNode({ type: 'server', key: 'srvdoc01', name: 'srvdoc01', source: 'confluence', attrs: { outOfInventory: true } });
    env.repo.upsertNode({ type: 'server', key: 'srvdoc02', name: 'srvdoc02', source: 'confluence' });
    env.repo.addEdge({ src: 'application:orderhub', dst: 'server:srvdoc02', type: 'runs_on', source: 'llm' });
    const r = reading({ links: [runsOn('srvdoc01', 'srvdoc01'), runsOn('srvdoc02', 'srvdoc02')] });
    const v = verifyReading(r, ctxOf(env, { pageText: 'srvdoc01 srvdoc02', naemonHosts: new Set(['srvdoc01', 'srvdoc02']), pageUpdatedAt: OLD }));
    assert.deepEqual(v.servers.map((s) => [s.inInventory, s.corroborated]), [[false, true], [false, true]]);
    assert.deepEqual(v.links.map((l) => l.trust), ['added', 'added']);
  });

  test('unknown application is linkable when ignoreOthers is false', () => {
    const env = setup(false);
    const r = reading({
      applications: [{ name: 'Inconnue', written: 'Inconnue', role: 'cited', evidence: 'Inconnue' }],
      links: [{ from: 'OrderHub', to: 'Inconnue', type: 'calls', evidence: 'appelle Inconnue' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'Inconnue appelle Inconnue' }));
    assert.deepEqual(v.rejected, []);
    assert.equal(v.links[0].dst, 'application:inconnue');
  });

  test('retired inventory edge does not count', () => {
    const env = setup();
    env.repo.addEdge({ src: 'application:orderhub', dst: env.s1, type: 'runs_on', source: 'apm', attrs: { retired: true } });
    env.repo.addEdge({ src: 'application:billing-engine', dst: env.s1, type: 'runs_on', source: 'apm' });
    const v = verifyReading(reading({ links: [runsOn('srvorh01', 'srvorh01')] }), ctxOf(env, { pageText: 'srvorh01' }));
    assert.equal(v.links[0].trust, 'otherApp');
  });
});

describe('période propre d\'un lien', () => {
  const page = (period) => ({ kind: 'project', period, env: null, topics: [] });
  const text = [
    'Existant : OrderHub tourne sur srvorh01',
    'Cible : OrderHub sur srvnew77',
    'Billing Engine appelle OrderHub depuis 2020',
    'Ancien serveur srvold55 arrêté, OrderHub y tournait',
    'srvfut66 à créer pour OrderHub',
  ].join('\n');

  test('the link period wins over the page period ; missing link period = page period', () => {
    const env = setup();
    const r = reading({
      page: page('target'),
      entities: [server('srvorh01', 'OrderHub tourne sur srvorh01'), server('srvnew77', 'OrderHub sur srvnew77', { status: 'planned' })],
      links: [
        runsOn('srvorh01', 'Existant : OrderHub tourne sur srvorh01', { period: 'current' }),
        runsOn('srvnew77', 'Cible : OrderHub sur srvnew77', { period: null }),
        { from: 'Billing Engine', to: 'OrderHub', type: 'calls', period: 'current', evidence: 'Billing Engine appelle OrderHub depuis 2020' },
        { from: 'OrderHub', to: 'Billing Engine', type: 'depends_on', evidence: 'Billing Engine appelle OrderHub depuis 2020' },
      ],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: text, headerText: 'Titre : OrderHub : architecture cible' }));
    assert.deepEqual(v.links.map((l) => [l.dstName, l.type, l.period, l.trust]), [
      ['srvorh01', 'runs_on', 'current', 'confirmed'],
      ['srvnew77', 'runs_on', 'target', 'toValidate'],
      ['OrderHub', 'calls', 'current', 'added'],
      ['Billing Engine', 'depends_on', 'target', 'added'],
    ]);
  });

  test('a link marked current to a server said decommissioned or planned stays past or target', () => {
    const env = setup();
    const r = reading({
      page: page('current'),
      entities: [server('srvold55', 'Ancien serveur srvold55 arrêté', { status: 'decommissioned' }), server('srvfut66', 'srvfut66 à créer', { status: 'planned' })],
      links: [runsOn('srvold55', 'Ancien serveur srvold55 arrêté, OrderHub y tournait', { period: 'current' }), runsOn('srvfut66', 'srvfut66 à créer pour OrderHub', { period: 'current' })],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: text }));
    assert.deepEqual(v.links.map((l) => [l.dstName, l.period]), [['srvold55', 'past'], ['srvfut66', 'target']]);
  });

  test('a link marked past in a current page is past ; unreadable page keeps links to validate', () => {
    const env = setup();
    const links = [{ from: 'Billing Engine', to: 'OrderHub', type: 'calls', period: 'past', periodEvidence: 'Flux de Billing Engine vers OrderHub supprimé en 2024', evidence: 'Billing Engine appelle OrderHub depuis 2020' }];
    const withStop = `${text}\nFlux de Billing Engine vers OrderHub supprimé en 2024`;
    assert.equal(verifyReading(reading({ page: page('current'), links }), ctxOf(env, { pageText: withStop })).links[0].period, 'past');
    const unreadable = verifyReading(reading({ page: page(null), links: [{ ...links[0], period: null }] }), ctxOf(env, { pageText: text })).links[0];
    assert.deepEqual([unreadable.period, unreadable.trust], ['current', 'toValidate']);
  });
});

describe('environnement de la page : seulement s\'il est écrit dans le titre ou les pages parentes', () => {
  const header = (title, parents = 'Accueil > Exploitation') => `Titre : ${title}\nPages parentes : ${parents}`;
  const body = 'srvdoc09 | 10.0.0.9\nServeurs de production\nLes deux brokers de production\nEnvironnement de pré-production';
  const ctx = (env, title, parents) => ctxOf(env, { headerText: header(title, parents), pageText: `${header(title, parents)}\n${title}\n${body}` });
  const withEnv = (env, envEvidence) => reading({ page: { kind: 'architecture', period: 'current', env, envEvidence, topics: [] }, entities: [server('srvdoc09', 'srvdoc09 | 10.0.0.9')] });

  test('kept when the quote is the title (or the parent pages) and names the environment', () => {
    const env = setup();
    assert.equal(verifyReading(withEnv('PRD', 'Serveurs de production OrderHub'), ctx(env, 'Serveurs de production OrderHub')).env, 'PRD');
    const v = verifyReading(withEnv('PRD', 'Production'), ctx(env, 'OrderHub : serveurs', 'Accueil > Production'));
    assert.equal(v.env, 'PRD');
    assert.deepEqual(v.rejected, []);
  });

  test('dropped without a quote, with a section title or a sentence of the body, or with a title that does not name it', () => {
    const env = setup();
    for (const [ev, reason] of [
      [null, 'no_evidence'],
      ['Serveurs de développement', 'no_evidence'],
      ['Serveurs de production', 'not_in_header'], // titre de section : ne suffit pas
      ['Les deux brokers de production', 'not_in_header'], // phrase sur quelques serveurs
      ['srvdoc09 | 10.0.0.9', 'not_in_header'], // déduit d'un nom de serveur
      ['Topologie OrderHub', 'evidence_mismatch'], // titre sans mot d'environnement
    ]) {
      const v = verifyReading(withEnv('PRD', ev), ctx(env, 'Topologie OrderHub'));
      assert.equal(v.env, null, String(ev));
      assert.deepEqual(v.rejected, [{ what: 'environnement de la page (PRD)', reason }], String(ev));
    }
    // sans en-tête fourni : jamais retenu
    assert.equal(verifyReading(withEnv('PRD', 'Serveurs de production'), ctxOf(env, { pageText: body })).env, null);
  });

  test('a dropped page env is not given to the servers of the page ; « pré-production » is not production', () => {
    const env = setup();
    const v = verifyReading(withEnv('PRD', 'Serveurs de production'), ctx(env, 'Topologie OrderHub'));
    assert.equal(v.servers.find((s) => s.name === 'srvdoc09').env, null);
    assert.equal(verifyReading(withEnv('PRD', 'OrderHub : pré-production'), ctx(env, 'OrderHub : pré-production')).env, null);
    assert.equal(verifyReading(withEnv('STG', 'OrderHub : pré-production'), ctx(env, 'OrderHub : pré-production')).env, 'STG');
  });

  test('house words count only once declared in mappings.json (environnements block)', () => {
    const { configureEnvironments } = require('../src/lib/environment');
    const env = setup();
    assert.equal(verifyReading(withEnv('STG', 'Infra OrderHub : recette'), ctx(env, 'Infra OrderHub : recette')).env, null);
    configureEnvironments({ STG: ['recette'] });
    try {
      assert.equal(verifyReading(withEnv('STG', 'Infra OrderHub : recette'), ctx(env, 'Infra OrderHub : recette')).env, 'STG');
    } finally {
      configureEnvironments(null);
    }
  });
});

describe('lien vers un serveur depuis une base (ou une file) : applications de la base d\'abord', () => {
  // page sur OrderHub qui cite la base de Billing Engine, hébergée sur le serveur de Billing Engine
  const text = 'OrderHub architecture\nBILREF | PostgreSQL | srvbil01\nBilling Engine utilise BILREF\nORHDB | srvbil01';
  const page = (links) =>
    reading({
      applications: [
        { name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub architecture' },
        { name: 'Billing Engine', written: 'Billing Engine', role: 'cited', evidence: 'Billing Engine utilise BILREF' },
      ],
      entities: [{ name: 'BILREF', type: 'database', status: 'active', evidence: 'BILREF | PostgreSQL | srvbil01' }, { name: 'ORHDB', type: 'database', status: 'active', evidence: 'ORHDB | srvbil01' }],
      links,
    });
  const dbOn = (db, evidence) => ({ from: db, to: 'srvbil01', type: 'db_on', evidence });
  const usesDb = (app, db, evidence) => ({ from: app, to: db, type: 'uses_db', evidence });

  test('database of the server owner, said in the page: added, not toValidate', () => {
    const env = setup();
    const v = verifyReading(page([usesDb('OrderHub', 'BILREF', 'BILREF | PostgreSQL | srvbil01'), usesDb('Billing Engine', 'BILREF', 'Billing Engine utilise BILREF'), dbOn('BILREF', 'BILREF | PostgreSQL | srvbil01')]), ctxOf(env, { pageText: text }));
    assert.deepEqual(v.links.find((l) => l.type === 'db_on').trust, 'added');
  });

  test('database of the server owner, known from the active graph (another page or an inventory): added', () => {
    const env = setup();
    env.repo.upsertNode({ type: 'database', key: 'bilref', name: 'BILREF', source: 'llm', attrs: { fromLlm: true } });
    env.repo.addEdge({ src: 'application:billing-engine', dst: 'database:bilref', type: 'uses_db', source: 'llm', sourceRef: '99', attrs: { trust: 'added', period: 'current' } });
    const v = verifyReading(page([usesDb('OrderHub', 'BILREF', 'BILREF | PostgreSQL | srvbil01'), dbOn('BILREF', 'BILREF | PostgreSQL | srvbil01')]), ctxOf(env, { pageText: text }));
    assert.equal(v.links.find((l) => l.type === 'db_on').trust, 'added');
  });

  test('inactive graph links do not count ; a database used only by the page application stays toValidate', () => {
    const env = setup();
    env.repo.upsertNode({ type: 'database', key: 'bilref', name: 'BILREF', source: 'llm', attrs: { fromLlm: true } });
    env.repo.addEdge({ src: 'application:billing-engine', dst: 'database:bilref', type: 'uses_db', source: 'llm', sourceRef: '99', attrs: { trust: 'added', period: 'past' } });
    const v = verifyReading(page([usesDb('OrderHub', 'BILREF', 'BILREF | PostgreSQL | srvbil01'), dbOn('BILREF', 'BILREF | PostgreSQL | srvbil01'), usesDb('OrderHub', 'ORHDB', 'ORHDB | srvbil01'), dbOn('ORHDB', 'ORHDB | srvbil01')]), ctxOf(env, { pageText: text }));
    assert.deepEqual(v.links.filter((l) => l.type === 'db_on').map((l) => [l.srcName, l.trust]), [['BILREF', 'toValidate'], ['ORHDB', 'toValidate']]);
  });
});

describe('serveur hors inventaire corroboré par une autre page', () => {
  test('an old page citing a server that another recent current page cites as active: added', () => {
    const env = setup();
    env.repo.upsertNode({ type: 'server', key: 'srvora01', name: 'srvora01', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    const doc = (key, updatedAt) => env.repo.upsertNode({ type: 'document', key, name: key, source: 'confluence', attrs: { updatedAt } });
    const r = reading({ entities: [server('srvora01', 'ORADB sur srvora01'), { name: 'ORADB', type: 'database', status: 'active', evidence: 'ORADB sur srvora01' }], links: [{ from: 'ORADB', to: 'srvora01', type: 'db_on', evidence: 'ORADB sur srvora01' }] });
    const ctx = ctxOf(env, { pageText: 'ORADB sur srvora01', pageUpdatedAt: OLD });
    // seulement une page ancienne ou une citation non actuelle : pas corroboré
    env.repo.addEdge({ src: doc('confluence-1', OLD), dst: 'server:srvora01', type: 'mentions', source: 'confluence', sourceRef: '1', attrs: { status: 'active', period: 'current' } });
    env.repo.addEdge({ src: doc('confluence-2', RECENT), dst: 'server:srvora01', type: 'mentions', source: 'confluence', sourceRef: '2', attrs: { status: 'active', period: 'target' } });
    env.repo.addEdge({ src: doc('confluence-3', RECENT), dst: 'server:srvora01', type: 'mentions', source: 'confluence', sourceRef: '3', attrs: { status: 'decommissioned', period: 'current' } });
    assert.equal(verifyReading(r, ctx).links[0].trust, 'toValidate');
    env.repo.addEdge({ src: doc('confluence-4', RECENT), dst: 'server:srvora01', type: 'mentions', source: 'confluence', sourceRef: '4', attrs: { status: 'active', period: 'current' } });
    // confluence-3, actuelle, le dit arrêté : contesté, une autre page active ne suffit plus
    const disputed = verifyReading(r, ctx);
    assert.deepEqual([disputed.servers[0].disputed, disputed.servers[0].corroborated, disputed.links[0].trust], [true, false, 'toValidate']);
    env.repo.patchNodeAttrs('document:confluence-3', { retired: true });
    const v = verifyReading(r, ctx);
    assert.equal(v.servers[0].corroborated, true);
    assert.equal(v.links[0].trust, 'added');
  });
});

describe('serveur hors inventaire dit arrêté par une autre page', () => {
  const setupOra = () => {
    const env = setup();
    env.repo.upsertNode({ type: 'server', key: 'srvora01', name: 'srvora01', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    const doc = (key, updatedAt) => env.repo.upsertNode({ type: 'document', key, name: key, source: 'confluence', attrs: { updatedAt } });
    const stop = (key, updatedAt, period) => env.repo.addEdge({ src: doc(key, updatedAt), dst: 'server:srvora01', type: 'mentions', source: 'confluence', sourceRef: key, attrs: { status: 'decommissioned', period } });
    return { env, stop };
  };
  const r = reading({ applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub tourne sur srvora01' }], entities: [server('srvora01', 'OrderHub tourne sur srvora01')], links: [runsOn('srvora01', 'OrderHub tourne sur srvora01')] });
  const ctx = (env) => ctxOf(env, { pageText: 'OrderHub tourne sur srvora01', pageUpdatedAt: RECENT, naemonHosts: new Set(['srvora01']) });

  test('supervised and cited active in this recent page: added, unless another current page says it is stopped', () => {
    const { env, stop } = setupOra();
    assert.equal(verifyReading(r, ctx(env)).links[0].trust, 'added');
    stop('confluence-20', OLD, 'current');
    const v = verifyReading(r, ctx(env));
    assert.deepEqual([v.servers[0].disputed, v.servers[0].corroborated, v.links[0].trust], [true, false, 'toValidate']);
  });

  test('an old page that says it is stopped counts only if it is more recent than this page', () => {
    const { env, stop } = setupOra();
    stop('confluence-21', OLD, 'past');
    assert.equal(verifyReading(r, ctx(env)).links[0].trust, 'added');
    stop('confluence-22', new Date(NOW - DAY).toISOString(), 'past');
    assert.equal(verifyReading(r, ctx(env)).links[0].trust, 'toValidate');
  });

  test('a server of the inventory is never disputed by a page', () => {
    const env = setup();
    const d = env.repo.upsertNode({ type: 'document', key: 'confluence-23', name: 'x', source: 'confluence', attrs: { updatedAt: RECENT } });
    env.repo.addEdge({ src: d, dst: env.s1, type: 'mentions', source: 'confluence', sourceRef: '23', attrs: { status: 'decommissioned', period: 'current' } });
    const v = verifyReading(reading({ entities: [server('srvorh01', 'OrderHub tourne sur srvorh01')], links: [runsOn('srvorh01', 'OrderHub tourne sur srvorh01')] }), ctxOf(env, { pageText: 'OrderHub tourne sur srvorh01' }));
    assert.deepEqual([v.servers[0].disputed, v.links[0].trust], [false, 'confirmed']);
  });
});

describe('période ancienne ou cible : seulement si une citation la prouve', () => {
  const body = 'Cartographie établie lors de l\'audit de 2024.\nOrderHub tourne sur srvorh01\nCette page est obsolète.';
  const pageOf = (period, periodEvidence) => reading({ page: { kind: 'architecture', period, periodEvidence, env: null, topics: [] }, links: [runsOn('srvorh01', 'OrderHub tourne sur srvorh01')] });
  const ctx = (env, title = 'Cartographie des flux (2024)') => ctxOf(env, { headerText: `Titre : ${title}\nPages parentes : Accueil`, pageText: `Titre : ${title}\n${body}` });

  test('a year alone (title or quote) does not make a page past: current, rejection recorded', () => {
    const env = setup();
    for (const quote of [undefined, 'Cartographie des flux (2024)', "Cartographie établie lors de l'audit de 2024"]) {
      const v = verifyReading(pageOf('past', quote), ctx(env));
      assert.equal(v.period, 'current');
      assert.equal(v.links[0].period, 'current');
      assert.ok(v.rejected.some((x) => x.what === 'période de la page (past)'));
    }
  });

  test('a quote of the page with a word of the period keeps it ; a marked title suffices ; an invented quote does not', () => {
    const env = setup();
    assert.equal(verifyReading(pageOf('past', 'Cette page est obsolète'), ctx(env)).period, 'past');
    assert.equal(verifyReading(pageOf('past', null), ctx(env, 'DAT OrderHub 2019 (archivée)')).period, 'past');
    assert.equal(verifyReading(pageOf('target', null), ctx(env, 'OrderHub : architecture cible')).period, 'target');
    const invented = verifyReading(pageOf('past', 'Page archivée'), ctx(env));
    assert.deepEqual([invented.period, invented.rejected.find((x) => x.what === 'période de la page (past)').reason], ['current', 'no_evidence']);
    // le mot doit être de la bonne période
    assert.equal(verifyReading(pageOf('target', 'Cette page est obsolète'), ctx(env)).period, 'current');
  });

  test('a link period other than the page one needs a quote that proves it', () => {
    const env = setup();
    const text = 'Billing Engine appelle OrderHub depuis 2020\nFlux supprimé en 2025 : Billing Engine vers OrderHub';
    const link = (over) => reading({ links: [{ from: 'Billing Engine', to: 'OrderHub', type: 'calls', period: 'past', evidence: 'Billing Engine appelle OrderHub depuis 2020', ...over }] });
    const c = ctxOf(env, { pageText: text });
    assert.equal(verifyReading(link({}), c).links[0].period, 'current');
    assert.equal(verifyReading(link({ periodEvidence: 'Flux supprimé en 2025 : Billing Engine vers OrderHub' }), c).links[0].period, 'past');
    assert.equal(verifyReading(link({ periodEvidence: 'Flux supprimé en 2026' }), c).links[0].period, 'current');
  });

  test('parent pages never prove a target page (a « Projets » folder may describe the existing), but still prove a past one', () => {
    const env = setup();
    const withParents = (title, parents, text = 'OrderHub tourne sur srvorh01') => {
      const header = `Titre : ${title}\nPages parentes : ${parents}`;
      return ctxOf(env, { headerText: header, pageText: `${header}\n${title}\n${text}` });
    };
    // l'IA cite le titre, ou la ligne des pages parentes : rangement seul, la page reste actuelle avec ses liens
    for (const quote of ['Migration Oracle 19c : plan de bascule', 'Pages parentes : Projets SI', 'Projets SI', null]) {
      const v = verifyReading(pageOf('target', quote), withParents('Migration Oracle 19c : plan de bascule', 'Projets SI'));
      assert.equal(v.period, 'current', String(quote));
      assert.equal(v.links[0].period, 'current', String(quote));
      assert.ok(v.rejected.some((x) => x.what === 'période de la page (target)'), String(quote));
    }
    // un lien cible qui ne cite que les pages parentes reste actuel
    const linkTarget = reading({ links: [runsOn('srvorh01', 'OrderHub tourne sur srvorh01', { period: 'target', periodEvidence: 'Pages parentes : Projets SI' })] });
    assert.equal(verifyReading(linkTarget, withParents('Plan de capacité 2026', 'Projets SI')).links[0].period, 'current');
    // le titre ou le contenu le disent : cible gardée, même sous « Projets SI »
    assert.equal(verifyReading(pageOf('target', null), withParents('Projet Portail 2025 : architecture cible', 'Projets SI')).period, 'target');
    const body = 'OrderHub tourne sur srvorh01\nArchitecture prévue pour 2027.';
    assert.equal(verifyReading(pageOf('target', 'Architecture prévue pour 2027'), withParents('Portail 2027', 'Projets SI', body)).period, 'target');
    // une page rangée sous « Archives » reste ancienne
    assert.equal(verifyReading(pageOf('past', null), withParents('DAT OrderHub', 'Accueil > Archives')).period, 'past');
  });
});

describe('serveur cité dans une commande « ssh compte@serveur »', () => {
  test('the server and its link are kept: the account before the @ is removed on both sides', () => {
    const env = setup();
    const { sanitizeReading } = require('../src/reading/schema');
    const text = 'Se connecter sur le premier nœud :\nssh deploy@srvnew88.rec.corp.example\nsudo systemctl stop orh';
    const raw = sanitizeReading({
      page: { kind: 'install', period: 'current' },
      entities: [{ name: 'srvnew88.rec.corp.example', type: 'server', env: 'STG', status: 'active', evidence: 'ssh deploy@srvnew88.rec.corp.example' }],
      links: [{ from: 'OrderHub', to: 'srvnew88.rec.corp.example', type: 'runs_on', evidence: 'Se connecter sur le premier nœud : ssh deploy@srvnew88.rec.corp.example' }],
    });
    assert.equal(raw.entities[0].evidence, 'ssh srvnew88.rec.corp.example');
    assert.ok(!/deploy/.test(JSON.stringify(raw)));
    const v = verifyReading(raw, ctxOf(env, { pageText: text }));
    assert.deepEqual(v.rejected, []);
    assert.deepEqual(v.servers.map((x) => x.name), ['srvnew88.rec.corp.example']);
    assert.deepEqual(v.links.map((l) => [l.type, l.dstName]), [['runs_on', 'srvnew88.rec.corp.example']]);
  });
});

describe('relecture round 1 : page elle-même, utilisateurs actuels, lien actuel dans une page ancienne', () => {
  const ora = (env) => env.repo.upsertNode({ type: 'server', key: 'srvora01', name: 'srvora01', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
  const doc = (env, key, attrs) => env.repo.upsertNode({ type: 'document', key, name: key, source: 'confluence', attrs: { updatedAt: RECENT, ...attrs } });
  const mention = (env, src) => env.repo.addEdge({ src, dst: 'server:srvora01', type: 'mentions', source: 'confluence', sourceRef: src, attrs: { status: 'active', period: 'current' } });
  const oraReading = () =>
    reading({
      entities: [server('srvora01', 'ORADB sur srvora01'), { name: 'ORADB', type: 'database', status: 'active', evidence: 'ORADB sur srvora01' }],
      links: [{ from: 'ORADB', to: 'srvora01', type: 'db_on', evidence: 'ORADB sur srvora01' }],
    });

  test('the page itself and retired documents do not corroborate a server', () => {
    const env = setup();
    ora(env);
    const own = doc(env, 'confluence-10');
    mention(env, own);
    mention(env, doc(env, 'confluence-11', { retired: true }));
    const ctx = ctxOf(env, { pageText: 'ORADB sur srvora01', pageUpdatedAt: OLD, docNodeId: own });
    assert.equal(verifyReading(oraReading(), ctx).links[0].trust, 'toValidate');
    mention(env, doc(env, 'confluence-12'));
    assert.equal(verifyReading(oraReading(), ctx).links[0].trust, 'added');
  });

  test('in the page, only current uses_db links make an application a user of the database', () => {
    const env = setup();
    const text = 'BILREF | srvbil01\nBilling Engine utilise BILREF (ancien usage)\nBilling Engine lit BILREF';
    const r = (links) =>
      reading({
        applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub' }],
        entities: [{ name: 'BILREF', type: 'database', status: 'active', evidence: 'BILREF | srvbil01' }],
        links: [...links, { from: 'BILREF', to: 'srvbil01', type: 'db_on', evidence: 'BILREF | srvbil01' }],
      });
    const ctx = ctxOf(env, { pageText: `OrderHub\n${text}` });
    const trustOf = (links) => verifyReading(r(links), ctx).links.find((l) => l.type === 'db_on').trust;
    assert.equal(trustOf([{ from: 'Billing Engine', to: 'BILREF', type: 'uses_db', period: 'past', evidence: 'Billing Engine utilise BILREF (ancien usage)' }]), 'toValidate');
    assert.equal(trustOf([{ from: 'Billing Engine', to: 'BILREF', type: 'reads_from', evidence: 'Billing Engine lit BILREF' }]), 'toValidate');
    assert.equal(trustOf([{ from: 'Billing Engine', to: 'BILREF', type: 'uses_db', evidence: 'Billing Engine utilise BILREF' }]), 'added');
  });

  test('a link marked current in a past page is at most toValidate, unless confirmed ; target pages are not affected', () => {
    const env = setup();
    const text = 'OrderHub tourne sur srvorh01\nBilling Engine appelle OrderHub\nOrderHub sur srvnew88';
    const r = (period) =>
      reading({
        page: { kind: 'architecture', period, env: null, topics: [] },
        entities: [server('srvnew88', 'OrderHub sur srvnew88')],
        links: [
          runsOn('srvorh01', 'OrderHub tourne sur srvorh01', { period: 'current' }),
          { from: 'Billing Engine', to: 'OrderHub', type: 'calls', period: 'current', evidence: 'Billing Engine appelle OrderHub' },
          runsOn('srvnew88', 'OrderHub sur srvnew88', { period: 'current' }),
        ],
      });
    const past = verifyReading(r('past'), ctxOf(env, { pageText: text, headerText: 'Titre : DAT OrderHub (obsolète)', naemonHosts: new Set(['srvnew88']) }));
    assert.deepEqual(past.links.map((l) => [l.dstName, l.period, l.trust]), [
      ['srvorh01', 'current', 'confirmed'],
      ['OrderHub', 'current', 'toValidate'],
      ['srvnew88', 'current', 'toValidate'],
    ]);
    const target = verifyReading(r('target'), ctxOf(env, { pageText: text, headerText: 'Titre : OrderHub : architecture cible', naemonHosts: new Set(['srvnew88']) }));
    assert.deepEqual(target.links.map((l) => l.trust), ['confirmed', 'added', 'added']);
  });
});
