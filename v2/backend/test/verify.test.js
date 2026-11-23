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
      links: [runsOn('srvorh01', 'srvorh01'), { from: 'OrderHub', to: 'Billing Engine', type: 'calls', evidence: 'appelle Billing' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'srvorh01 appelle Billing' }));
    assert.deepEqual(v.links.map((l) => l.period), ['target', 'target']);
    const past = verifyReading({ ...r, page: { ...r.page, period: 'past' } }, ctxOf(env, { pageText: 'srvorh01 appelle Billing' }));
    assert.deepEqual(past.links.map((l) => l.period), ['past', 'past']);
  });

  test('document links are added with the page period', () => {
    const env = setup();
    const r = reading({
      entities: [{ name: 'DB_ORDERS', type: 'database', env: null, status: 'active', evidence: 'DB_ORDERS' }],
      links: [{ from: 'ORH', to: 'Billing Engine', type: 'calls', evidence: 'appelle Billing' }, { from: 'OrderHub', to: 'DB_ORDERS', type: 'uses_db', evidence: 'base DB_ORDERS' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'appelle Billing, base DB_ORDERS' }));
    assert.deepEqual(v.links.map((l) => [l.type, l.trust, l.period]), [['calls', 'added', 'current'], ['uses_db', 'added', 'current']]);
    assert.equal(v.links[0].src, 'application:orderhub');
    assert.equal(v.links[0].dst, 'application:billing-engine');
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
    const v = verifyReading(r, ctxOf(env, { pageText: 'Awa Diallo astreinte. Equipe X. Sans' }));
    assert.deepEqual(v.owners, [{ appId: 'application:orderhub', name: 'Awa Diallo', kind: 'person', role: 'oncall', period: 'past', evidence: 'Awa Diallo astreinte' }]);
    assert.deepEqual(v.rejected.map((x) => x.reason), ['unknown_application', 'unknown_application']);
  });

  test('null page period makes non-confirmed links toValidate', () => {
    const env = setup();
    const r = reading({
      page: { kind: 'architecture', period: null, env: null, topics: [] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub' }],
      links: [runsOn('srvorh01', 'srvorh01'), { from: 'OrderHub', to: 'Billing Engine', type: 'calls', evidence: 'Billing' }],
      owners: [{ name: 'Awa', kind: 'person', application: 'ORH', role: 'owner', evidence: 'Awa Diallo' }],
    });
    const v = verifyReading(r, ctxOf(env, { pageText: 'OrderHub srvorh01 Billing Awa Diallo' }));
    assert.deepEqual(v.links.map((l) => l.trust), ['confirmed', 'toValidate']);
    assert.equal(v.apps.length, 1);
    assert.equal(v.owners[0].period, 'current');
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
