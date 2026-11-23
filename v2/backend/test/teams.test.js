'use strict';
const assert = require('assert').strict;
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const views = require('../src/api/views');
const { gapsView } = require('../src/api/views2');
const { computeGaps, writeGapsReport } = require('../src/naemon/gaps');
const { docScore } = require('../src/quality/docScore');

let repo;
beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
});

const app = (name, attrs = {}) => repo.upsertNode({ type: 'application', key: name, name, source: 'apm', attrs: { perimeter: true, ...attrs } });
const page = (key, attrs = {}) => repo.upsertNode({ type: 'document', key, name: `Page ${key}`, source: 'confluence', attrs: { url: `http://wiki/${key}`, ...attrs } });
const owner = (appId, kind, name, attrs, docId) => {
  const id = repo.upsertNode({ type: kind, key: name.toLowerCase(), name, source: 'llm', attrs: { fromLlm: true } });
  repo.addEdge({ src: appId, dst: id, type: 'owned_by', source: 'llm', attrs: { role: 'owner', period: 'current', docId, ...attrs } });
  return id;
};

describe('équipes et responsables', () => {
  test('teams groups doc owners and apm owners with source', () => {
    const d = page('p1');
    const a1 = app('Alto');
    const a2 = app('Borea', { owner: 'Ada Martin', supportTeam: 'Equipe Socle' });
    const a3 = app('Cirrus');
    const teamId = owner(a1, 'team', 'Equipe Socle', { role: 'support' }, d);
    owner(a3, 'team', 'Equipe Socle', { role: 'oncall', period: 'past' }, d);
    const teams = views.listTeams(repo);
    const socle = teams.find((t) => t.name === 'Equipe Socle');
    assert.equal(socle.kind, 'team');
    assert.equal(socle.id, teamId);
    // doc d'abord pour Alto et Cirrus, APM pour Borea, dans le même groupe (même nom et même nature)
    assert.deepEqual(socle.applications.map((x) => [x.name, x.source, x.role, x.period]).sort(), [
      ['Alto', 'doc', 'support', 'current'],
      ['Borea', 'apm', 'support', 'current'],
      ['Cirrus', 'doc', 'oncall', 'past'],
    ]);
    assert.deepEqual(socle.applications.find((x) => x.name === 'Alto').docs, [{ id: d, title: 'Page p1', url: 'http://wiki/p1' }]);
    assert.deepEqual(socle.applications.find((x) => x.name === 'Borea').docs, []);
    const ada = teams.find((t) => t.name === 'Ada Martin');
    assert.equal(ada.kind, 'person');
    assert.equal(ada.id, null);
    assert.equal(ada.applications[0].source, 'apm');
    assert.equal(ada.applications[0].role, 'owner');
    assert.equal(teams[0].name, 'Equipe Socle'); // le plus d'applications d'abord
  });

  test('unassigned group lists apps without owner', () => {
    const a1 = app('Alto');
    app('Borea');
    owner(a1, 'person', 'Ada Martin', {});
    const teams = views.listTeams(repo);
    const last = teams[teams.length - 1];
    assert.equal(last.kind, 'unassigned');
    assert.equal(last.id, null);
    assert.deepEqual(last.applications.map((x) => x.name), ['Borea']);
    assert.equal(teams.filter((t) => t.kind === 'unassigned').length, 1);
  });

  test('application detail exposes owners and document role', () => {
    const d = page('p1');
    const a = app('Alto', { supportTeam: 'Equipe Socle' });
    owner(a, 'person', 'Ada Martin', { period: 'past' }, d);
    repo.addEdge({ src: a, dst: d, type: 'documented_in', source: 'confluence', attrs: { role: 'cited' } });
    const det = views.applicationDetail(repo, a);
    assert.deepEqual(det.owners.map((o) => [o.name, o.kind, o.role, o.period, o.source]), [
      ['Equipe Socle', 'team', 'support', 'current', 'apm'],
      ['Ada Martin', 'person', 'owner', 'past', 'doc'],
    ]);
    assert.equal(det.owners[1].docs[0].title, 'Page p1');
    assert.equal(det.documents[0].role, 'cited');
    assert.equal(det.documents[0].period, null);
  });

  test('gaps lists toValidate links', () => {
    const a = app('Alto');
    const d = page('p1');
    const s = repo.upsertNode({ type: 'server', key: 'srvalto09', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'llm', confidence: 0.5, attrs: { trust: 'toValidate', period: 'current', docId: d } });
    const raw = computeGaps(repo, null);
    assert.equal(raw.toValidate.length, 1);
    const { gaps } = gapsView({ repo, poller: null });
    assert.equal(gaps.counts.toValidate, 1);
    assert.equal(gaps.toValidate[0].server.name, 'srvalto09');
    assert.equal(gaps.toValidate[0].application.name, 'Alto');
    assert.equal(gaps.toValidate[0].page.title, 'Page p1');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-gaps-'));
    const csv = fs.readFileSync(writeGapsReport(dir, raw), 'utf8');
    assert.match(csv, /srvalto09/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('inactive runs_on links are not counted as not monitored', () => {
    const a = app('Alto');
    const s = repo.upsertNode({ type: 'server', key: 'srvold', source: 'llm', attrs: {} });
    repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'llm', attrs: { trust: 'added', period: 'past' } });
    const r = computeGaps(repo, { servers: { [s]: { state: 'not_monitored' } } });
    assert.equal(r.notMonitored.length, 0);
  });

  test('docScore ignores cited-only pages', () => {
    const a = app('Alto');
    const d = page('p1', { pageKind: 'architecture' });
    repo.addEdge({ src: a, dst: d, type: 'documented_in', source: 'confluence', attrs: { role: 'cited' } });
    assert.equal(docScore(repo, a).parts.find((p) => p.key === 'architecture').points, 0);
    const d2 = page('p2', { pageKind: 'architecture' });
    repo.addEdge({ src: a, dst: d2, type: 'documented_in', source: 'confluence', attrs: { role: 'subject' } });
    assert.equal(docScore(repo, a).parts.find((p) => p.key === 'architecture').points, 35);
  });

  test('server lists flag outOfInventory and show inactive links with their marks', () => {
    const a = app('Alto');
    const s = repo.upsertNode({ type: 'server', key: 'srvghost', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'llm', attrs: { trust: 'added', period: 'past' } });
    const det = views.applicationDetail(repo, a);
    assert.equal(det.servers, 0);
    assert.equal(det.serverList[0].outOfInventory, true);
    assert.equal(det.serverList[0].period, 'past');
    assert.equal(det.serverList[0].active, false);
    assert.equal(views.searchServers(repo, 'srvghost')[0].outOfInventory, true);
  });
});
