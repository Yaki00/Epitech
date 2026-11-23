'use strict';
const assert = require('assert').strict;
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const views = require('../src/api/views');

let repo;
beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
  const s1 = repo.upsertNode({ type: 'server', key: 'srvalto01.dom.example.com', aliases: ['10.0.0.1'], source: 'marketplace', attrs: { ip: '10.0.0.1', environment: 'prod' } });
  const s2 = repo.upsertNode({ type: 'server', key: 'srvalto02', source: 'marketplace', attrs: { environment: 'DEV' } });
  const db = repo.upsertNode({ type: 'database', key: 'ORA_ALTO', name: 'ORA_ALTO', source: 't' });
  const alto = repo.upsertNode({ type: 'application', key: 'ALTO', name: 'ALTO', source: 'apm', attrs: { criticality: 'Medium', supportTeam: 'Équipe Front', owner: 'J. Dupont' } });
  const brief = repo.upsertNode({ type: 'application', key: 'BRIEF', name: 'BRIEF', source: 'apm' });
  repo.addEdge({ src: alto, dst: s1, type: 'runs_on', source: 'marketplace' });
  repo.addEdge({ src: alto, dst: s1, type: 'runs_on', source: 'llm', confidence: 0.6 });
  repo.addEdge({ src: alto, dst: s2, type: 'runs_on', source: 'apm' });
  repo.addEdge({ src: alto, dst: db, type: 'uses_db', source: 'drawio', confidence: 0.8 });
  repo.addEdge({ src: brief, dst: alto, type: 'calls', source: 'drawio', confidence: 0.8 });
});

describe('vues API', () => {
  test('criticité depuis confidentiality, environnements limités à PRD/STG/DEV, env des serveurs recherchés', () => {
    const x = repo.upsertNode({ type: 'application', key: 'XAPP', name: 'XAPP', source: 'apm', attrs: { confidentiality: 'C3' } });
    const sa = repo.upsertNode({ type: 'server', key: 'srvx01', source: 'apm', attrs: { environment: 'Pré-production' } });
    const sb = repo.upsertNode({ type: 'server', key: 'srvx02', source: 'apm', attrs: { environment: 'recette' } });
    repo.addEdge({ src: x, dst: sa, type: 'runs_on', source: 'apm' });
    repo.addEdge({ src: x, dst: sb, type: 'runs_on', source: 'apm' });
    const app = views.listApplications(repo).find((a) => a.name === 'XAPP');
    assert.equal(app.criticality, 'C3');
    assert.deepEqual(app.environments, ['STG']);
    assert.equal(views.searchServers(repo, 'srvx01')[0].env, 'STG');
    assert.equal(views.searchServers(repo, 'srvx02')[0].env, null);
    assert.equal(views.applicationDetail(repo, x).serverList.find((n) => n.name === 'srvx01').env, 'STG');
  });
  test('liste des applications avec compteurs et environnements des serveurs', () => {
    const alto = views.listApplications(repo).find((a) => a.name === 'ALTO');
    assert.equal(alto.servers, 2);
    assert.equal(alto.databases, 1);
    assert.deepEqual(alto.environments, ['DEV', 'PRD']);
    assert.equal(alto.criticality, 'Medium');
  });
  test('fiche : serveurs dédoublonnés (meilleure confiance, toutes les sources)', () => {
    const d = views.applicationDetail(repo, 'application:alto');
    const s1 = d.serverList.find((s) => s.id === 'server:srvalto01');
    assert.equal(d.serverList.length, 2);
    assert.equal(s1.confidence, 1);
    assert.deepEqual(s1.sources.sort(), ['llm', 'marketplace']);
    assert.equal(d.databaseList[0].name, 'ORA_ALTO');
    assert.deepEqual(d.usedBy, [{ id: 'application:brief', name: 'BRIEF' }]);
    assert.equal(views.applicationDetail(repo, 'server:srvalto01'), null);
  });
  test('recherche serveur par IP renvoie les applications hébergées', () => {
    const r = views.searchServers(repo, '10.0.0.1');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].applications.map((a) => a.name), ['ALTO']);
  });
  test('équipes, "Non renseignée" en dernier', () => {
    const t = views.listTeams(repo);
    assert.equal(t[0].name, 'Équipe Front');
    assert.deepEqual(t[0].owners, ['J. Dupont']);
    assert.equal(t.at(-1).name, 'Non renseignée');
  });
  test('config UI', () => {
    assert.deepEqual(views.uiConfig({ NAEMON_URL_TEMPLATE: 'http://n/{app}' }), { naemonUrlTemplate: 'http://n/{app}', sources: { servicenow: false, bitbucket: false } });
  });
});
