'use strict';
const assert = require('assert').strict;
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { runTool, TOOLS } = require('../src/assistant/ask');

let repo;
beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
});

describe('outils du chat', () => {
  test('owners_of tool answers both directions', () => {
    const a = repo.upsertNode({ type: 'application', key: 'Alto', name: 'Alto', source: 'apm', attrs: { supportTeam: 'Equipe Socle' } });
    const p = repo.upsertNode({ type: 'person', key: 'ada martin', name: 'Ada Martin', source: 'llm', attrs: {} });
    repo.addEdge({ src: a, dst: p, type: 'owned_by', source: 'llm', attrs: { role: 'owner', period: 'past' } });
    assert.ok(TOOLS.some((t) => t.function.name === 'owners_of'));
    const r1 = runTool(repo, 'owners_of', { id: a });
    assert.deepEqual(r1.owners.map((o) => [o.name, o.kind, o.role, o.period]), [
      ['Equipe Socle', 'team', 'support', 'current'],
      ['Ada Martin', 'person', 'owner', 'past'],
    ]);
    const r2 = runTool(repo, 'owners_of', { id: p });
    assert.equal(r2.applications[0].name, 'Alto');
    assert.equal(r2.applications[0].period, 'past');
    assert.ok(runTool(repo, 'search_entities', { query: 'ada' }).some((n) => n.type === 'person'));
    assert.ok(runTool(repo, 'owners_of', { id: 'nope' }).error);
  });

  test('impact tool output flags past links as past', () => {
    const a = repo.upsertNode({ type: 'application', key: 'Alto', name: 'Alto', source: 'apm', attrs: {} });
    const b = repo.upsertNode({ type: 'application', key: 'Borea', name: 'Borea', source: 'apm', attrs: {} });
    const s = repo.upsertNode({ type: 'server', key: 'srvx', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'llm', attrs: { trust: 'added', period: 'past' } });
    repo.addEdge({ src: b, dst: s, type: 'runs_on', source: 'llm', attrs: { trust: 'toValidate', period: 'current' } });
    const r = runTool(repo, 'impact_analysis', { id: s });
    assert.equal(r.total, 0); // aucun lien actif
    const past = r.inactiveLinks.find((l) => l.from.name === 'Alto');
    assert.equal(past.period, 'past');
    assert.equal(r.inactiveLinks.find((l) => l.from.name === 'Borea').trust, 'toValidate');
    assert.equal(r.start.outOfInventory, true);
    const search = runTool(repo, 'search_entities', { query: 'srvx' });
    assert.equal(search[0].outOfInventory, true);
  });

  test('impact items carry outOfInventory and link marks', () => {
    const a = repo.upsertNode({ type: 'application', key: 'Alto', name: 'Alto', source: 'apm', attrs: {} });
    const s = repo.upsertNode({ type: 'server', key: 'srvy', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    repo.addEdge({ src: a, dst: s, type: 'runs_on', source: 'llm', attrs: { trust: 'added', period: 'current' } });
    const r = runTool(repo, 'dependencies', { id: a });
    assert.equal(r.items[0].outOfInventory, true);
    assert.equal(r.items[0].trust, 'added');
    assert.equal(r.items[0].period, 'current');
  });
});

describe('outils de documentation', () => {
  const { jsonToolsPrompt, systemFor } = require('../src/assistant/ask');
  test('json tools mode offers the two new tools', () => {
    for (const lang of ['fr', 'en']) {
      const p = jsonToolsPrompt(lang);
      assert.match(p, /search_knowledge\(query, application\)/);
      assert.match(p, /open_fiche\(id\)/);
    }
    assert.ok(TOOLS.some((t) => t.function.name === 'search_knowledge'));
    assert.ok(TOOLS.some((t) => t.function.name === 'open_fiche'));
    assert.match(systemFor('en'), /nothing found in the documentation/);
    assert.doesNotMatch(systemFor('fr') + systemFor('en'), new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});
