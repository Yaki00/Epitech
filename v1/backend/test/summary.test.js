'use strict';
const assert = require('assert').strict;

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { summaryInputs, summarizeApplication, saveSummary, buildMessages } = require('../src/enrich/summary');

function setup() {
  const repo = createRepo(openStore(':memory:'));
  repo.upsertNode({ type: 'application', key: 'OrderHub', attrs: { perimeter: true, auid: 'ECO-1', profile: 'Critique' }, source: 'perimeter' });
  repo.upsertNode({ type: 'application', key: 'Billing', name: 'Billing', source: 'apm' });
  repo.upsertNode({ type: 'application', key: 'Portail', name: 'Portail', source: 'apm' });
  for (const [k, env] of [['srv1', 'PROD'], ['srv2', 'PROD'], ['srv3', 'RECETTE']]) {
    repo.upsertNode({ type: 'server', key: k, attrs: { environment: env, os: 'Linux', osVersion: 'RHEL 9' }, source: 'apm' });
    repo.addEdge({ src: 'application:orderhub', dst: `server:${k}`, type: 'runs_on', source: 'apm', confidence: 1 });
  }
  repo.upsertNode({ type: 'database', key: 'ORA_OHB', name: 'ORA_OHB', source: 'llm' });
  repo.addEdge({ src: 'application:orderhub', dst: 'database:ora_ohb', type: 'uses_db', source: 'llm', confidence: 0.8 });
  repo.addEdge({ src: 'application:orderhub', dst: 'application:billing', type: 'calls', source: 'llm', confidence: 0.8 });
  repo.addEdge({ src: 'application:portail', dst: 'application:orderhub', type: 'calls', source: 'drawio', confidence: 0.8 });
  const doc = (id, title, excerpt, attrs = {}, confidence = 0.95) => {
    repo.upsertNode({ type: 'document', key: `confluence-${id}`, name: title, source: 'confluence', attrs: { excerpt, ...attrs } });
    repo.addEdge({ src: 'application:orderhub', dst: `document:confluence-${id}`, type: 'documented_in', source: 'confluence', sourceRef: id, confidence });
  };
  doc('1', 'OrderHub', 'Prise de commande des agences.', { updatedAt: '2026-01-01' });
  doc('2', 'OrderHub - Architecture', 'Deux serveurs de production en cluster.', { pageKind: 'architecture', updatedAt: '2025-01-01' }, 0.85);
  doc('3', 'Notes', 'x'.repeat(5000), { updatedAt: '2020-01-01' }, 0.6);
  repo.upsertNode({ type: 'document', key: 'confluence-4', name: 'Sans texte', source: 'confluence' });
  repo.addEdge({ src: 'application:orderhub', dst: 'document:confluence-4', type: 'documented_in', source: 'confluence', sourceRef: '4', confidence: 0.9 });
  return repo;
}

describe('résumé IA des applications', () => {
  test('pages : architecture d\'abord, pages sans texte écartées, budget de texte respecté', () => {
    const repo = setup();
    const inputs = summaryInputs(repo, repo.getNode('application:orderhub'), { maxChars: 3100 });
    assert.deepEqual(inputs.docs.map((d) => d.title), ['OrderHub - Architecture', 'OrderHub', 'Notes']);
    assert.ok(inputs.docs.reduce((n, d) => n + d.excerpt.length, 0) <= 3100);
  });

  test('faits sûrs tirés du graphe', () => {
    const { facts } = summaryInputs(setup(), setup().getNode('application:orderhub'));
    assert.equal(facts.serveurs, 3);
    assert.deepEqual(facts.environnements.sort(), ['PROD (2)', 'RECETTE (1)']);
    assert.deepEqual(facts.os, ['Linux RHEL 9 (3)']);
    assert.deepEqual(facts.bases, ['ORA_OHB']);
    assert.deepEqual(facts.appelle, ['Billing']);
    assert.deepEqual(facts.utilisee_par, ['Portail']);
    assert.equal(facts.auid, 'ECO-1');
  });

  test('empreinte : stable, change si une page change', () => {
    const repo = setup();
    const app = () => repo.getNode('application:orderhub');
    const h1 = summaryInputs(repo, app()).hash;
    assert.equal(summaryInputs(repo, app()).hash, h1);
    repo.upsertNode({ type: 'document', key: 'confluence-1', name: 'OrderHub', source: 'confluence', attrs: { excerpt: 'Nouveau texte.' } });
    assert.notEqual(summaryInputs(repo, app()).hash, h1);
  });

  test('appel IA, enregistrement du résumé et de ses sources', async () => {
    const repo = setup();
    const app = repo.getNode('application:orderhub');
    const inputs = summaryInputs(repo, app);
    let sent;
    const llm = {
      chatJson: async (req) => ((sent = req), { summary: 'OrderHub gère la prise de commande des agences sur deux serveurs de production.', summary_en: 'OrderHub handles branch order intake on two production servers.' }),
    };
    const summary = await summarizeApplication(llm, app, inputs);
    assert.equal(summary.en, 'OrderHub handles branch order intake on two production servers.');
    assert.equal(sent.task, 'summary');
    assert.match(sent.messages[1].content, /Faits d'inventaire/);
    assert.match(sent.messages[1].content, /\(architecture\)/);
    saveSummary(repo, app, summary, inputs, new Date('2026-11-18T08:00:00Z'));
    const saved = repo.getNode('application:orderhub').attrs;
    assert.equal(saved.summary, summary.fr);
    assert.equal(saved.summaryEn, summary.en);
    assert.equal(saved.summaryHash, inputs.hash);
    assert.equal(saved.summarySources.length, 3);
    assert.equal(saved.perimeter, true); // les autres attributs sont gardés
    await assert.rejects(() => summarizeApplication({ chatJson: async () => ({ summary: '' }) }, app, inputs), /vide/);
    // anglais absent : le français reste, l'interface l'affiche à défaut
    assert.equal((await summarizeApplication({ chatJson: async () => ({ summary: 'Résumé en français assez long.' }) }, app, inputs)).en, null);
  });

  test('le prompt interdit d\'inventer et signale les pages anciennes', () => {
    const repo = setup();
    const [sys] = buildMessages(repo.getNode('application:orderhub'), summaryInputs(repo, repo.getNode('application:orderhub')));
    assert.match(sys.content, /N'invente rien/);
    assert.match(sys.content, /plus de 2 ans/);
    assert.match(sys.content, /summary_en/);
  });
});
