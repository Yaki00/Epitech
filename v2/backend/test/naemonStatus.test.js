'use strict';
const assert = require('assert').strict;
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createMatcher } = require('../src/perimeter/perimeter');
const { computeStatus } = require('../src/naemon/status');

let repo;
const addApp = (name) => repo.upsertNode({ type: 'application', key: name, name, attrs: { perimeter: true }, source: 'test' });
const addSrv = (name, env, app, attrs = {}) => {
  const id = repo.upsertNode({ type: 'server', key: name, name, attrs: { environment: env, ...attrs }, source: 'test', aliases: attrs.ip ? [attrs.ip] : [] });
  if (app) repo.addEdge({ src: `application:${app}`, dst: id, type: 'runs_on', source: 'test' });
  return id;
};
const host = (name, state = 0, extra = {}) => ({ name, address: '', state, output: `out ${name}`, lastCheck: 100, groups: [], ack: false, downtime: false, ...extra });
const svc = (h, description, state, extra = {}) => ({ host: h, description, state, output: `${description} out`, lastCheck: 100, ack: false, downtime: false, ...extra });
const raw = (hosts = [], services = []) => ({ fetchedAt: '2026-01-01T00:00:00Z', hosts, services });

beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
  addApp('alto');
  addApp('brief');
});

describe('computeStatus : serveurs', () => {
  test('hôte DOWN donne down, UNREACHABLE donne unknown', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    addSrv('srvalto02', 'PRD', 'alto');
    const r = computeStatus(repo, raw([host('srvalto01', 1), host('srvalto02', 2)]));
    assert.equal(r.fetchedAt, '2026-01-01T00:00:00Z');
    assert.equal(r.servers['server:srvalto01'].state, 'down');
    assert.equal(r.servers['server:srvalto02'].state, 'unknown');
  });
  test('hôte UP : le pire service décide', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    addSrv('srvalto02', 'PRD', 'alto');
    addSrv('srvalto03', 'PRD', 'alto');
    addSrv('srvalto04', 'PRD', 'alto');
    const r = computeStatus(
      repo,
      raw(
        [host('srvalto01'), host('srvalto02'), host('srvalto03'), host('srvalto04')],
        [svc('srvalto01', 'cpu', 0), svc('srvalto01', 'disk', 1), svc('srvalto02', 'cpu', 1), svc('srvalto02', 'disk', 2), svc('srvalto03', 'cpu', 3), svc('srvalto04', 'cpu', 0)]
      )
    );
    assert.equal(r.servers['server:srvalto01'].state, 'warning');
    assert.equal(r.servers['server:srvalto02'].state, 'critical');
    assert.equal(r.servers['server:srvalto03'].state, 'unknown');
    assert.equal(r.servers['server:srvalto04'].state, 'ok');
    assert.equal(r.servers['server:srvalto02'].services.length, 2);
  });
  test('acquittement conservé sans changer l état', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const r = computeStatus(repo, raw([host('srvalto01', 1, { ack: true })]));
    assert.equal(r.servers['server:srvalto01'].state, 'down');
    assert.equal(r.servers['server:srvalto01'].ack, true);
  });
  test('serveur absent de Naemon : not_monitored', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const r = computeStatus(repo, raw());
    assert.equal(r.servers['server:srvalto01'].state, 'not_monitored');
  });
  test('rapprochement par FQDN et par IP', () => {
    addSrv('srvalto01', 'PRD', 'alto', { ip: '10.0.0.1' });
    addSrv('srvalto02', 'PRD', 'alto', { ip: '10.0.0.2' });
    const r = computeStatus(repo, raw([host('srvalto01.dom.example.com', 1), host('autrenom', 1, { address: '10.0.0.2' })]));
    assert.equal(r.servers['server:srvalto01'].state, 'down');
    assert.equal(r.servers['server:srvalto02'].state, 'down');
  });
});

describe('computeStatus : applications', () => {
  test('2 serveurs PRD dont 1 down : degraded ; 2 down : down', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    addSrv('srvalto02', 'PRD', 'alto');
    let r = computeStatus(repo, raw([host('srvalto01', 1), host('srvalto02')]));
    assert.equal(r.apps['application:alto'].byEnv.PRD, 'degraded');
    assert.equal(r.apps['application:alto'].state, 'degraded');
    r = computeStatus(repo, raw([host('srvalto01', 1), host('srvalto02', 1)]));
    assert.equal(r.apps['application:alto'].byEnv.PRD, 'down');
    assert.equal(r.apps['application:alto'].state, 'down');
  });
  test('maintenance : état maintenance, ignorée dans le calcul, ne propage pas', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    addSrv('srvbrief01', 'PRD', 'brief');
    repo.addEdge({ src: 'application:brief', dst: 'application:alto', type: 'calls', source: 'test' });
    const r = computeStatus(repo, raw([host('srvalto01', 1, { downtime: true }), host('srvbrief01')]));
    assert.equal(r.servers['server:srvalto01'].state, 'maintenance');
    assert.equal(r.apps['application:alto'].byEnv.PRD, 'unknown');
    assert.deepEqual(r.atRisk, {});
  });
  test('application sans serveur supervisé : unknown', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const r = computeStatus(repo, raw());
    assert.equal(r.apps['application:alto'].state, 'unknown');
    assert.equal(r.apps['application:alto'].byEnv.PRD, 'unknown');
    assert.equal(r.apps['application:brief'].state, 'unknown');
  });
  test('DEV down n affecte pas state ; STG sert si pas de PRD', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    addSrv('srvalto02', 'DEV', 'alto');
    addSrv('srvbrief01', 'STG', 'brief');
    const r = computeStatus(repo, raw([host('srvalto01'), host('srvalto02', 1), host('srvbrief01', 1)]));
    assert.equal(r.apps['application:alto'].state, 'ok');
    assert.equal(r.apps['application:alto'].byEnv.DEV, 'down');
    assert.equal(r.apps['application:brief'].state, 'down');
  });
  test('serveur retiré ignoré', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const old = addSrv('srvalto02', 'PRD', 'alto');
    repo.patchNodeAttrs(old, { retired: true });
    const r = computeStatus(repo, raw([host('srvalto01'), host('srvalto02', 1)]));
    assert.equal(r.apps['application:alto'].state, 'ok');
    assert.equal(r.servers[old], undefined);
  });
});

describe('computeStatus : impact réel', () => {
  test('atRisk via calls, avec le chemin', () => {
    addApp('hera');
    addSrv('srvalto01', 'PRD', 'alto');
    repo.addEdge({ src: 'application:brief', dst: 'application:alto', type: 'calls', source: 'test' });
    repo.addEdge({ src: 'application:hera', dst: 'application:brief', type: 'calls', source: 'test' });
    const r = computeStatus(repo, raw([host('srvalto01', 1)]));
    assert.deepEqual(r.atRisk['application:brief'], { because: 'application:alto', path: ['application:brief', 'application:alto'] });
    assert.deepEqual(r.atRisk['application:hera'], { because: 'application:alto', path: ['application:hera', 'application:brief', 'application:alto'] });
    assert.equal(r.atRisk['application:alto'], undefined);
  });
  test('lien retiré ne propage pas', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    repo.addEdge({ src: 'application:brief', dst: 'application:alto', type: 'calls', source: 'test' });
    const e = repo.allEdges().find((x) => x.type === 'calls');
    repo.patchEdgeAttrs(e.id, { retired: true });
    const r = computeStatus(repo, raw([host('srvalto01', 1)]));
    assert.deepEqual(r.atRisk, {});
  });
});

describe('computeStatus : périmètre', () => {
  test('hôte inconnu et hors périmètre ignoré', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const r = computeStatus(repo, raw([host('srvinconnu99', 1, { groups: ['autres'] })]));
    assert.deepEqual(Object.keys(r.servers), ['server:srvalto01']);
    assert.deepEqual(r.unmatchedHosts, []);
  });
  test('hôte inconnu dont un hostgroup matche une application : unmatchedHosts', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const matcher = createMatcher({ applications: [{ name: 'alto', aliases: [] }, { name: 'brief', aliases: [] }] }, repo);
    const r = computeStatus(repo, raw([host('srvnouveau01', 1, { groups: ['ALTO'] }), host('srvautre', 1, { groups: ['zzz'] })]), { matcher });
    assert.deepEqual(r.unmatchedHosts, ['srvnouveau01']);
    assert.equal(r.servers['server:srvalto01'].state, 'not_monitored');
  });
  test('naemonHostgroups d une application reconnu', () => {
    const matcher = createMatcher({ applications: [{ name: 'alto', aliases: [] }] }, repo);
    matcher.apps[0].naemonHostgroups = ['hg_alto_prd'];
    const r = computeStatus(repo, raw([host('srvnouveau01', 0, { groups: ['HG_ALTO_PRD'] })]), { matcher });
    assert.deepEqual(r.unmatchedHosts, ['srvnouveau01']);
  });
  test('pureté : l entrée n est pas modifiée', () => {
    addSrv('srvalto01', 'PRD', 'alto');
    const input = raw([host('srvalto01', 1)], [svc('srvalto01', 'cpu', 2)]);
    const copy = JSON.stringify(input);
    computeStatus(repo, input);
    assert.equal(JSON.stringify(input), copy);
  });
});

describe('liens inactifs', () => {
  test('inactive llm runs_on does not make a server belong to the app', () => {
    const real = addSrv('srvalto01', 'PRD', 'alto');
    const ghost = addSrv('srvghost01', 'PRD', null);
    repo.addEdge({ src: 'application:alto', dst: ghost, type: 'runs_on', source: 'llm', sourceRef: 'p1', attrs: { trust: 'toValidate', period: 'current' } });
    const r = computeStatus(repo, raw([host('srvalto01', 0), host('srvghost01', 1)]));
    assert.equal(r.servers[real].state, 'ok');
    assert.equal(r.servers[ghost].state, 'down');
    assert.equal(r.apps['application:alto'].state, 'ok'); // le serveur à valider ne compte pas
  });
});
