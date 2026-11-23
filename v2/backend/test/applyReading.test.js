'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { applyReading } = require('../src/reading/apply');

const NOW = Date.parse('2026-11-23T10:00:00Z');
const PAGE = 'p100';
const DOC = 'document:p100';

function setup() {
  const repo = createRepo(openStore(':memory:'));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-apply-')), 'perimeter.json');
  fs.writeFileSync(file, JSON.stringify({ applications: ['OrderHub', 'Billing Engine'] }));
  const perimeter = loadPerimeter(file);
  ensurePerimeterNodes(repo, perimeter);
  const s1 = repo.upsertNode({ type: 'server', key: 'srvorh01', name: 'srvorh01', source: 'apm', attrs: { environment: 'PRD' } });
  const s2 = repo.upsertNode({ type: 'server', key: 'srvorh02', name: 'srvorh02', source: 'apm', attrs: { environment: 'PRD' } });
  repo.addEdge({ src: 'application:orderhub', dst: s1, type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: 'application:orderhub', dst: s2, type: 'runs_on', source: 'apm' });
  repo.upsertNode({ type: 'document', key: 'p100', name: 'Architecture OrderHub', source: 'confluence', attrs: { pageKind: 'architecture' } });
  const matcher = createMatcher(perimeter, repo);
  return { repo, matcher, s1, s2 };
}

const srv = (name, nodeId, over = {}) => ({ nodeId, name, env: 'PRD', status: 'active', inInventory: Boolean(nodeId), corroborated: false, evidence: `${name} cité`, ...over });
const link = (src, dst, type, trust, over = {}) => ({ src, dst, type, trust, period: 'current', evidence: `${src} ${type} ${dst}`, ...over });
const verified = (over = {}) => ({
  kind: 'architecture', period: 'current', env: 'PRD', topics: ['servers'],
  apps: [{ appId: 'application:orderhub', role: 'subject', written: 'OrderHub', evidence: 'OrderHub' }],
  servers: [], links: [], owners: [], rejected: [], ...over,
});
const page = { title: 'Architecture OrderHub', updatedAt: '2026-10-01T00:00:00Z', sections: [], tables: [], diagrams: [] };
const apply = (env, v) => applyReading(env.repo, v, { pageId: PAGE, docNodeId: DOC, page, matcher: env.matcher, now: NOW });

describe('applyReading', () => {
  test('purge keeps inventory edges', () => {
    const env = setup();
    env.repo.addEdge({ src: 'application:orderhub', dst: env.s1, type: 'runs_on', source: 'confluence', sourceRef: PAGE });
    env.repo.addEdge({ src: 'application:orderhub', dst: env.s2, type: 'runs_on', source: 'llm', sourceRef: PAGE });
    env.repo.addEdge({ src: DOC, dst: env.s1, type: 'mentions', source: 'confluence', sourceRef: PAGE });
    env.repo.addEdge({ src: DOC, dst: env.s1, type: 'mentions', source: 'confluence', sourceRef: 'p999' });
    assert.equal(env.repo.removeEdgesBySourceRef(PAGE, { sources: ['confluence', 'llm', 'drawio'] }), 3);
    const rest = env.repo.allEdges().filter((e) => e.type === 'runs_on' || e.type === 'mentions');
    assert.equal(rest.filter((e) => e.source === 'apm').length, 2);
    assert.equal(rest.filter((e) => e.sourceRef === 'p999').length, 1);
    assert.equal(rest.length, 3);
    assert.equal(env.repo.edgesFrom('application:orderhub').filter((e) => e.source !== 'apm').length, 0);
    assert.equal(env.repo.edgesTo(env.s1).filter((e) => e.type === 'mentions').length, 1);
  });

  test('re-applying a smaller reading removes old links', () => {
    const env = setup();
    const big = verified({
      servers: [srv('srvorh01', env.s1), srv('srvorh02', env.s2)],
      links: [link('application:orderhub', env.s1, 'runs_on', 'added'), link('application:orderhub', env.s2, 'runs_on', 'added')],
    });
    apply(env, big);
    const llm = () => env.repo.allEdges().filter((e) => e.source === 'llm');
    assert.equal(llm().length, 2);
    assert.equal(env.repo.edgesTo(env.s2).filter((e) => e.type === 'mentions').length, 1);
    const small = verified({ servers: [srv('srvorh01', env.s1)], links: [link('application:orderhub', env.s1, 'runs_on', 'added')] });
    const r = apply(env, small);
    assert.equal(llm().length, 1);
    assert.equal(llm()[0].dst, env.s1);
    assert.equal(env.repo.edgesTo(env.s2).filter((e) => e.type === 'mentions').length, 0);
    assert.equal(r.mentions, 1);
    assert.equal(r.links, 1);
    assert.equal(env.repo.allEdges().filter((e) => e.source === 'apm').length, 2);
  });

  test('documented_in carries role and audit only for subject architecture pages', () => {
    const env = setup();
    const v = verified({
      apps: [
        { appId: 'application:orderhub', role: 'subject', written: 'OrderHub', evidence: 'OrderHub' },
        { appId: 'application:billing-engine', role: 'cited', written: 'Billing', evidence: 'Billing' },
      ],
      servers: [srv('srvorh01', env.s1)],
    });
    apply(env, v);
    const doc = (appId) => env.repo.edgesFrom(appId).find((e) => e.type === 'documented_in');
    assert.equal(doc('application:orderhub').attrs.role, 'subject');
    assert.equal(doc('application:orderhub').attrs.written, 'OrderHub');
    assert.deepEqual(doc('application:orderhub').attrs.audit.confirmed, ['srvorh01']);
    assert.equal(doc('application:billing-engine').attrs.role, 'cited');
    assert.equal(doc('application:billing-engine').attrs.audit, undefined);
    assert.equal(doc('application:orderhub').source, 'confluence');
    assert.equal(doc('application:orderhub').sourceRef, PAGE);
    const node = env.repo.getNode(DOC);
    assert.equal(node.attrs.pageKind, 'architecture');
    assert.equal(node.attrs.pageKindAi, 'architecture');
    assert.equal(node.attrs.period, 'current');
    assert.equal(node.attrs.env, 'PRD');

    // la page n'est plus une page d'architecture : pageKind disparaît, plus d'audit
    apply(env, verified({ kind: 'meeting', env: null, period: 'past' }));
    const after = env.repo.getNode(DOC);
    assert.ok(!('pageKind' in after.attrs));
    assert.equal(after.attrs.pageKindAi, 'meeting');
    assert.equal(after.attrs.period, 'past');
    assert.equal(doc('application:orderhub').attrs.audit, undefined);
  });

  test('out-of-inventory server is created with outOfInventory', () => {
    const env = setup();
    const v = verified({
      servers: [srv('srvnew01', null, { inInventory: false, corroborated: true })],
      links: [link('application:orderhub', 'server:srvnew01', 'runs_on', 'added')],
    });
    const r = apply(env, v);
    const node = env.repo.getNode('server:srvnew01');
    assert.ok(node);
    assert.equal(node.attrs.fromLlm, true);
    assert.equal(node.attrs.outOfInventory, true);
    const e = env.repo.edgesFrom('application:orderhub').find((x) => x.source === 'llm');
    assert.equal(e.dst, 'server:srvnew01');
    assert.equal(e.sourceRef, PAGE);
    assert.equal(e.attrs.trust, 'added');
    assert.equal(e.attrs.period, 'current');
    assert.equal(e.attrs.docId, DOC);
    assert.ok(e.attrs.evidence);
    assert.equal(r.links, 1);
    assert.ok(env.repo.edgesFrom(DOC).some((x) => x.type === 'mentions' && x.dst === 'server:srvnew01'));
  });

  test('toValidate, otherApp and confirmed links', () => {
    const env = setup();
    const v = verified({
      servers: [srv('srvorh01', env.s1), srv('srvx', null, { inInventory: false })],
      links: [
        link('application:orderhub', 'server:srvx', 'runs_on', 'toValidate'),
        link('application:billing-engine', env.s1, 'runs_on', 'otherApp'),
        link('application:orderhub', env.s1, 'runs_on', 'confirmed'),
        link('application:orderhub', 'database:ora_orh', 'uses_db', 'added', { period: 'past' }),
      ],
    });
    const r = apply(env, v);
    const llm = env.repo.allEdges().filter((e) => e.source === 'llm');
    assert.equal(llm.length, 2);
    assert.equal(llm.find((e) => e.dst === 'server:srvx').attrs.trust, 'toValidate');
    assert.equal(llm.find((e) => e.dst === 'database:ora_orh').attrs.period, 'past');
    assert.ok(env.repo.getNode('database:ora_orh'));
    assert.equal(r.toValidate, 1);
    assert.equal(r.otherApp, 1);
    assert.equal(r.links, 2);
  });

  test('owned_by edges to person and team', () => {
    const env = setup();
    const v = verified({
      owners: [
        { appId: 'application:orderhub', name: 'Jeanne Martin', kind: 'person', role: 'owner', period: 'current', evidence: 'Jeanne Martin responsable' },
        { appId: 'application:orderhub', name: 'Equipe Socle', kind: 'team', role: 'support', period: 'past', evidence: 'Equipe Socle support' },
      ],
    });
    const r = apply(env, v);
    assert.equal(r.owners, 2);
    const owned = env.repo.edgesFrom('application:orderhub').filter((e) => e.type === 'owned_by');
    assert.equal(owned.length, 2);
    const p = owned.find((e) => e.dst.startsWith('person:'));
    const t = owned.find((e) => e.dst.startsWith('team:'));
    assert.equal(env.repo.getNode(p.dst).name, 'Jeanne Martin');
    assert.equal(env.repo.getNode(t.dst).name, 'Equipe Socle');
    assert.equal(p.source, 'llm');
    assert.deepEqual({ role: p.attrs.role, period: p.attrs.period, docId: p.attrs.docId }, { role: 'owner', period: 'current', docId: DOC });
    assert.equal(t.attrs.period, 'past');
  });
});
