'use strict';
/**
 * Lecture IA face à l'inventaire, de bout en bout (vérification, écriture, retrait, vues, écarts) :
 * citation qui ne nomme pas l'élément, liens vers des serveurs d'autres applications ou hors inventaire,
 * serveurs cités seulement comme anciens, appels entrants inactifs.
 */
const assert = require('assert').strict;
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { ingestInventory } = require('../src/ingest/inventory');
const { verifyReading } = require('../src/reading/verify');
const { applyReading } = require('../src/reading/apply');
const { retireOrphans, verifyHashOf } = require('../src/reading/syncPages');
const { impactOf } = require('../src/graph/impact');
const { applicationDetail, searchServers, listTeams, ownersOfApp } = require('../src/api/views');
const { computeGaps } = require('../src/naemon/gaps');
const { docScore } = require('../src/quality/docScore');
const { createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const OLD_PAGE = '2020-01-01T00:00:00Z';
const SERVER_MAPPING = { entity: 'server', key: 'Host', relations: [{ column: 'App', entity: 'application', type: 'runs_on', direction: 'from' }] };

function setup() {
  const repo = createRepo(openStore(':memory:'));
  const perimeter = { applications: [{ name: 'OrderHub', aliases: ['ORH'] }, { name: 'Billing', aliases: [] }], ignoreOtherApplications: true };
  ensurePerimeterNodes(repo, perimeter);
  ingestInventory(repo, { source: 'apm', records: [{ App: 'OrderHub', Host: 'srvorh01' }, { App: 'Billing', Host: 'srvbil01' }], mapping: SERVER_MAPPING });
  return { repo, perimeter, matcher: createMatcher(perimeter, repo) };
}

const PAGE_TEXT = [
  'OrderHub architecture',
  'Les serveurs de production sont listés ci-dessous.',
  'Ancien serveur srvold99 arrêté en 2019.',
  'Billing appelle OrderHub (ancien flux, supprimé).',
  'La base dbghost est hébergée sur srvghost42.',
  'OrderHub dépend de srvbil01 pour les factures.',
].join('\n');

const probeReading = () => ({
  page: { kind: 'architecture', period: 'current', env: 'PRD', topics: ['servers'] },
  applications: [
    { name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub architecture' },
    { name: 'Billing', written: 'Billing', role: 'cited', evidence: 'Billing appelle OrderHub' },
  ],
  entities: [
    { name: 'srvghost42', type: 'server', env: 'PRD', status: 'active', evidence: 'Les serveurs de production' },
    { name: 'srvold99', type: 'server', env: 'PRD', status: 'decommissioned', evidence: 'Ancien serveur srvold99 arrêté en 2019' },
    { name: 'dbghost', type: 'database', status: 'active', evidence: 'Les serveurs de production' },
  ],
  links: [
    { from: 'OrderHub', to: 'srvghost42', type: 'runs_on', evidence: 'Les serveurs de production' },
    { from: 'OrderHub', to: 'dbghost', type: 'uses_db', evidence: 'Les serveurs de production' },
    { from: 'dbghost', to: 'srvghost42', type: 'db_on', evidence: 'Les serveurs de production' },
    { from: 'OrderHub', to: 'srvbil01', type: 'depends_on', evidence: 'Les serveurs de production' },
    { from: 'Billing', to: 'OrderHub', type: 'calls', evidence: 'Billing appelle OrderHub (ancien flux' },
  ],
  owners: [],
});

const verify = (env, reading, over = {}) =>
  verifyReading(reading, { pageText: PAGE_TEXT, diagramsText: '', repo: env.repo, matcher: env.matcher, naemonHosts: new Set(), pageUpdatedAt: OLD_PAGE, now: NOW, ...over });
const apply = (env, v, pageId = '1', period = undefined) => {
  const docNodeId = `document:confluence-${pageId}`;
  env.repo.upsertNode({ type: 'document', key: `confluence-${pageId}`, name: `Page ${pageId}`, source: 'confluence', attrs: period ? { period } : {} });
  return applyReading(env.repo, v, { pageId, docNodeId, page: { updatedAt: OLD_PAGE }, matcher: env.matcher, now: NOW });
};

describe('citation qui ne nomme pas l\'élément', () => {
  test('invented server quoted with a generic sentence is rejected (evidence_mismatch)', () => {
    const env = setup();
    const v = verify(env, probeReading());
    assert.ok(!v.servers.some((s) => s.name === 'srvghost42'));
    assert.ok(v.rejected.some((r) => r.what === 'srvghost42' && r.reason === 'evidence_mismatch'));
    assert.ok(v.rejected.some((r) => r.what === 'dbghost' && r.reason === 'evidence_mismatch'));
    // aucun des liens cités par « Les serveurs de production » n'est gardé
    assert.deepEqual(v.links.map((l) => [l.src, l.type, l.dst]), [['application:billing', 'calls', 'application:orderhub']]);
    assert.equal(v.rejected.filter((r) => r.reason === 'evidence_mismatch').length, 6);
    apply(env, v);
    assert.ok(!env.repo.getNode('server:srvghost42'));
    assert.deepEqual(impactOf(env.repo, 'server:srvorh01').items.map((i) => i.id).sort(), ['application:billing', 'application:orderhub']);
  });

  test('a server quoted by its short name or its FQDN is accepted, an owner must be named', () => {
    const env = setup();
    env.repo.patchNodeAttrs('server:srvorh01', { fqdn: 'srvorh01.corp.example' });
    const text = 'Hôte srvorh01.corp.example ; srv-orh-01 ; Responsable : Alice Martin ; Équipe : la meilleure';
    const v = verify(env, {
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [],
      entities: [
        { name: 'srvorh01', type: 'server', status: 'active', evidence: 'Hôte srvorh01.corp.example' },
        { name: 'srvorh01.corp.example', type: 'server', status: 'active', evidence: 'srv-orh-01' },
      ],
      links: [],
      owners: [
        { name: 'Alice Martin', kind: 'person', application: 'OrderHub', role: 'owner', evidence: 'Responsable : Alice Martin' },
        { name: 'Equipe Socle', kind: 'team', application: 'OrderHub', role: 'support', evidence: 'Équipe : la meilleure' },
      ],
    }, { pageText: text });
    assert.equal(v.servers.length, 1);
    assert.equal(v.servers[0].nodeId, 'server:srvorh01');
    assert.deepEqual(v.owners.map((o) => o.name), ['Alice Martin']);
    assert.deepEqual(v.rejected, [{ what: 'Equipe Socle', reason: 'evidence_mismatch' }]);
  });

  test('a link is kept when the quote names either end', () => {
    const env = setup();
    const text = 'ORH dépend du flux FX ; flux FX vers Billing';
    const v = verify(env, {
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [],
      entities: [],
      links: [
        { from: 'OrderHub', to: 'Billing', type: 'calls', evidence: 'ORH dépend du flux FX' },
        { from: 'OrderHub', to: 'Billing', type: 'depends_on', evidence: 'flux FX vers Billing' },
        { from: 'OrderHub', to: 'Billing', type: 'reads_from', evidence: 'dépend du flux FX' },
      ],
      owners: [],
    }, { pageText: text, pageUpdatedAt: '2026-10-01' });
    assert.deepEqual(v.links.map((l) => l.type), ['calls', 'depends_on']);
    assert.deepEqual(v.rejected.map((r) => r.reason), ['evidence_mismatch']);
  });
});

describe('liens vers un serveur : confiance au-delà de runs_on', () => {
  const reading = () => ({
    page: { kind: 'architecture', period: 'current', env: 'PRD', topics: [] },
    applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub architecture' }],
    entities: [
      { name: 'srvghost42', type: 'server', status: 'active', evidence: 'hébergée sur srvghost42' },
      { name: 'dbghost', type: 'database', status: 'active', evidence: 'La base dbghost' },
    ],
    links: [
      { from: 'dbghost', to: 'srvghost42', type: 'db_on', evidence: 'La base dbghost est hébergée sur srvghost42' },
      { from: 'OrderHub', to: 'srvbil01', type: 'depends_on', evidence: 'OrderHub dépend de srvbil01' },
      { from: 'OrderHub', to: 'srvorh01', type: 'depends_on', evidence: 'OrderHub architecture srvorh01' },
    ],
    owners: [],
  });

  test('db_on to an uncorroborated out-of-inventory server and depends_on to another app server are toValidate, out of impact', () => {
    const env = setup();
    const v = verify(env, reading(), { pageText: `${PAGE_TEXT}\nOrderHub architecture srvorh01` });
    assert.deepEqual(v.links.map((l) => [l.type, l.dst, l.trust]), [
      ['db_on', 'server:srvghost42', 'toValidate'],
      ['depends_on', 'server:srvbil01', 'toValidate'],
      ['depends_on', 'server:srvorh01', 'added'],
    ]);
    apply(env, v);
    assert.ok(!impactOf(env.repo, 'server:srvghost42').items.some((i) => i.id === 'database:dbghost'));
    assert.ok(!impactOf(env.repo, 'server:srvbil01').items.some((i) => i.id === 'application:orderhub'));
    // la règle runs_on ne change pas : un serveur d'une autre application reste `otherApp`
    const r = verify(env, { ...reading(), links: [{ from: 'OrderHub', to: 'srvbil01', type: 'runs_on', evidence: 'OrderHub dépend de srvbil01' }] });
    assert.equal(r.links[0].trust, 'otherApp');
  });

  test('db_on to an out-of-inventory server corroborated by Naemon is added', () => {
    const env = setup();
    const v = verify(env, reading(), { naemonHosts: new Set(['srvghost42']) });
    assert.equal(v.links.find((l) => l.type === 'db_on').trust, 'added');
  });

  test('link ends resolve only to infrastructure and application nodes', () => {
    const env = setup();
    env.repo.upsertNode({ type: 'person', key: 'zorro', name: 'Zorro', source: 'llm' });
    const v = verify(env, {
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [],
      entities: [],
      links: [{ from: 'OrderHub', to: 'Zorro', type: 'depends_on', evidence: 'OrderHub dépend de Zorro' }],
      owners: [],
    }, { pageText: 'OrderHub dépend de Zorro' });
    assert.deepEqual(v.links, []);
    assert.deepEqual(v.rejected, [{ what: 'OrderHub depends_on Zorro', reason: 'out_of_scope' }]);
  });
});

describe('serveurs cités seulement comme anciens', () => {
  test('a reading-made server cited only as decommissioned is retired and is not a gap', () => {
    const env = setup();
    const v = verify(env, probeReading());
    const out = apply(env, v);
    assert.equal(out.mentions, 1);
    const mention = env.repo.edgesTo('server:srvold99').find((e) => e.type === 'mentions');
    assert.deepEqual(mention.attrs, { status: 'decommissioned', period: 'current' });
    assert.equal(retireOrphans(env.repo, NOW), 1);
    assert.equal(env.repo.getNode('server:srvold99').attrs.retired, true);
    assert.deepEqual(searchServers(env.repo, 'srvold99').map((s) => [s.name, s.retired]), [['srvold99', true]]);
    // contrôle de la page : à part, pas un serveur inconnu
    const audit = env.repo.edgesFrom('application:orderhub').find((e) => e.type === 'documented_in').attrs.audit;
    assert.deepEqual(audit.unknown, []);
    assert.deepEqual(audit.formerCited, ['srvold99']);
    assert.ok(!audit.problems.some((p) => p.code === 'unknown'));
    assert.deepEqual(computeGaps(env.repo, null).citedNotInInventory, []);
  });

  test('a reading-made server cited active in a current page stays, cited in a past page only is retired', () => {
    const env = setup();
    const reading = (status) => ({
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub sur srvx01' }],
      entities: [{ name: 'srvx01', type: 'server', status, evidence: 'OrderHub sur srvx01' }],
      links: [],
      owners: [],
    });
    const ctx = { pageText: 'OrderHub sur srvx01' };
    apply(env, verify(env, reading('active'), ctx), '1');
    apply(env, verify(env, { ...reading('active'), page: { kind: 'architecture', period: 'past', topics: [] } }, ctx), '2', 'past');
    retireOrphans(env.repo, NOW);
    assert.equal(env.repo.getNode('server:srvx01').attrs.retired, undefined);
    assert.deepEqual(computeGaps(env.repo, null).citedNotInInventory, ['srvx01']);
    // la page actuelle ne le cite plus : seule reste la page ancienne
    apply(env, verify(env, { ...reading('active'), entities: [] }, ctx), '1');
    assert.equal(retireOrphans(env.repo, NOW), 1);
    assert.equal(env.repo.getNode('server:srvx01').attrs.retired, true);
    // un serveur hors inventaire cité par une page ancienne n'est pas un écart actuel
    assert.deepEqual(computeGaps(env.repo, null).citedNotInInventory, []);
  });

  test('a server whose status is unreadable stays active (à valider), not retired', () => {
    const env = setup();
    const v = verify(env, {
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub sur srvx02' }],
      entities: [{ name: 'srvx02', type: 'server', status: null, evidence: 'OrderHub sur srvx02' }],
      links: [{ from: 'OrderHub', to: 'srvx02', type: 'runs_on', evidence: 'OrderHub sur srvx02' }],
      owners: [],
    }, { pageText: 'OrderHub sur srvx02' });
    apply(env, v);
    assert.equal(retireOrphans(env.repo, NOW), 0);
    assert.equal(computeGaps(env.repo, null).toValidate.length, 1);
  });
});

describe('IP citées', () => {
  test('an IP that matches no server creates no node; an IP given as a page server ip designates it', () => {
    const env = setup();
    const text = 'srvx03 | 10.9.9.3 ; adresse 10.9.9.3 ; passerelle 10.9.9.254 ; OrderHub';
    const v = verify(env, {
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub' }],
      entities: [
        { name: '10.9.9.3', type: 'ip', status: 'active', evidence: 'adresse 10.9.9.3' },
        { name: '10.9.9.254', type: 'ip', status: 'active', evidence: 'passerelle 10.9.9.254' },
        { name: 'srvx03', type: 'server', ip: '10.9.9.3', status: 'active', evidence: 'srvx03 | 10.9.9.3' },
      ],
      links: [],
      owners: [],
    }, { pageText: text, pageUpdatedAt: '2026-10-01' });
    assert.deepEqual(v.servers.map((s) => s.name), ['srvx03']);
    assert.deepEqual(v.ips.map((i) => i.ip), ['10.9.9.254']);
    apply(env, v);
    assert.equal(env.repo.listByType('server').filter((n) => /^10\./.test(n.name)).length, 0);
    const audit = env.repo.edgesFrom('application:orderhub').find((e) => e.type === 'documented_in').attrs.audit;
    assert.deepEqual(audit.unknown.sort(), ['10.9.9.254', 'srvx03']);
  });
});

describe('appels entrants', () => {
  test('usedBy carries the marks: an inactive incoming call is greyed and not counted', () => {
    const env = setup();
    apply(env, verify(env, probeReading()));
    const det = applicationDetail(env.repo, 'application:orderhub');
    assert.deepEqual(det.usedBy.map((u) => [u.id, u.active, u.retired, u.trust, u.period]), [['application:billing', true, false, 'added', 'current']]);
    // même appel lu dans une page ancienne
    const env2 = setup();
    apply(env2, verify(env2, { ...probeReading(), page: { kind: 'architecture', period: 'past', topics: [] } }), '1', 'past');
    const old = applicationDetail(env2.repo, 'application:orderhub').usedBy;
    assert.deepEqual(old.map((u) => [u.id, u.active, u.retired, u.period]), [['application:billing', false, true, 'past']]);
  });
});

describe('inventaire après une lecture', () => {
  test('a relation-target server first read in a page loses outOfInventory and fromLlm', () => {
    const repo = createRepo(openStore(':memory:'));
    const perimeter = { applications: [{ name: 'OrderHub', aliases: [] }], ignoreOtherApplications: true };
    ensurePerimeterNodes(repo, perimeter);
    const env = { repo, matcher: createMatcher(perimeter, repo) };
    const reading = {
      page: { kind: 'architecture', period: 'current', topics: [] },
      applications: [{ name: 'OrderHub', written: 'OrderHub', role: 'subject', evidence: 'OrderHub tourne sur srvnew01' }],
      entities: [{ name: 'srvnew01', type: 'server', status: 'active', evidence: 'OrderHub tourne sur srvnew01' }],
      links: [{ from: 'OrderHub', to: 'srvnew01', type: 'runs_on', evidence: 'OrderHub tourne sur srvnew01' }],
      owners: [],
    };
    const ctx = { pageText: 'OrderHub tourne sur srvnew01', pageUpdatedAt: '2026-10-01' };
    apply(env, verify(env, reading, ctx));
    assert.equal(repo.getNode('server:srvnew01').attrs.outOfInventory, true);
    const mapping = { entity: 'application', key: 'App', relations: [{ column: 'Host', entity: 'server', type: 'runs_on', direction: 'to' }] };
    ingestInventory(repo, { source: 'apm', records: [{ App: 'OrderHub', Host: 'srvnew01' }], mapping });
    const attrs = repo.getNode('server:srvnew01').attrs;
    assert.equal(attrs.outOfInventory, undefined);
    assert.equal(attrs.fromLlm, undefined);
    env.matcher = createMatcher(perimeter, repo);
    const v = verify(env, reading, ctx);
    assert.equal(v.servers[0].inInventory, true);
    assert.equal(v.links[0].trust, 'confirmed');
    apply(env, v);
    const audit = repo.edgesFrom('application:orderhub').find((e) => e.type === 'documented_in').attrs.audit;
    assert.deepEqual(audit.unknown, []);
    assert.deepEqual(audit.confirmed, ['srvnew01']);
  });
});

describe('responsables de période inconnue et anciens seulement', () => {
  test('owners of an unreadable-period page keep period null and are not current', () => {
    const env = setup();
    const v = verify(env, {
      page: { kind: 'operations', period: null, topics: [] },
      applications: [],
      entities: [],
      links: [],
      owners: [{ name: 'Alice Martin', kind: 'person', application: 'OrderHub', role: 'owner', evidence: 'Responsable : Alice Martin' }],
    }, { pageText: 'Responsable : Alice Martin' });
    assert.equal(v.owners[0].period, null);
    apply(env, v);
    const owners = ownersOfApp(env.repo, env.repo.getNode('application:orderhub'));
    assert.deepEqual(owners.map((o) => [o.name, o.period]), [['Alice Martin', null]]);
    // période inconnue : pas « Non renseignée » (quelqu'un est cité), mais jamais compté comme actuel
    const teams = listTeams(env.repo);
    const alice = teams.find((t) => t.name === 'Alice Martin');
    assert.deepEqual(alice.applications.map((a) => a.period), [null]);
    assert.ok(!teams.find((t) => t.kind === 'unassigned').applications.some((a) => a.id === 'application:orderhub'));
  });

  test('apps with only former owners go to the unassigned group with formerOnly', () => {
    const env = setup();
    const v = verify(env, {
      page: { kind: 'operations', period: 'past', topics: [] },
      applications: [],
      entities: [],
      links: [],
      owners: [{ name: 'Bruno Petit', kind: 'person', application: 'OrderHub', role: 'owner', evidence: 'Responsable : Bruno Petit' }],
    }, { pageText: 'Responsable : Bruno Petit' });
    apply(env, v);
    const teams = listTeams(env.repo);
    const unassigned = teams.find((t) => t.kind === 'unassigned');
    assert.deepEqual(unassigned.applications.map((a) => [a.name, a.formerOnly]).sort(), [['Billing', undefined], ['OrderHub', true]]);
    // l'application reste aussi sur la carte de l'ancien responsable
    assert.deepEqual(teams.find((t) => t.name === 'Bruno Petit').applications.map((a) => [a.name, a.period]), [['OrderHub', 'past']]);
  });
});

describe('score de documentation et empreinte de vérification', () => {
  test('past and target architecture pages give no architecture points and no gap', () => {
    const env = setup();
    const doc = env.repo.upsertNode({ type: 'document', key: 'old', name: 'Archi 2018', source: 'confluence', attrs: { pageKind: 'architecture', period: 'past' } });
    env.repo.addEdge({ src: 'application:orderhub', dst: doc, type: 'documented_in', source: 'confluence', sourceRef: 'old', attrs: { role: 'subject', audit: { ok: false, confirmed: [] } } });
    const parts = Object.fromEntries(docScore(env.repo, 'application:orderhub').parts.map((p) => [p.key, p.points]));
    assert.equal(parts.architecture, 0);
    assert.equal(parts.architectureClean, 0);
    env.repo.patchNodeAttrs(doc, { period: 'current' });
    assert.equal(docScore(env.repo, 'application:orderhub').parts.find((p) => p.key === 'architecture').points, 35);
  });

  test('verify hash changes with the month', () => {
    const env = setup();
    const a = verifyHashOf(env.repo, new Set(), Date.parse('2026-11-23T12:00:00Z'));
    assert.equal(verifyHashOf(env.repo, new Set(), Date.parse('2026-11-30T23:00:00Z')), a);
    assert.notEqual(verifyHashOf(env.repo, new Set(), Date.parse('2026-12-01T12:00:00Z')), a);
  });
});
