'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher, ensurePerimeterNodes, editDistance, acronym } = require('../src/perimeter/perimeter');
const { ingestInventory } = require('../src/ingest/inventory');

function perimeterFile(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-perimetre-')), 'perimeter.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

const PERIMETER = loadPerimeter(
  perimeterFile({
    applications: [
      { name: 'OrderHub', aliases: ['ORH'] },
      { name: 'Gestion Commerciale Entreprises', aliases: [] },
      { name: 'Billing Engine', auid: 'AUID-0042' },
      'Alto',
    ],
  })
);

describe('outils', () => {
  test('distance avec inversion de lettres', () => {
    assert.equal(editDistance('orderhub', 'odrerhub'), 1);
    assert.equal(editDistance('orderhub', 'orderhb'), 1);
    assert.equal(editDistance('orderhub', 'xyz', 2), 3);
  });
  test('sigle', () => assert.equal(acronym('Gestion Commerciale Entreprises'), 'gce'));
  test('ancienne liste de mots-clés de titre ignorée : même empreinte, aucun champ exposé', () => {
    const plain = loadPerimeter(perimeterFile({ applications: ['OrderHub'] }));
    const old = loadPerimeter(perimeterFile({ applications: ['OrderHub'], architectureKeywords: ['dat'] }));
    assert.equal(old.hash, plain.hash);
    assert.deepEqual(Object.keys(old).sort(), ['applications', 'hash', 'ignoreOtherApplications']);
  });
  test('fichier absent = pas de périmètre ; liste vide = erreur', () => {
    assert.equal(loadPerimeter(path.join(os.tmpdir(), 'nexiste-pas.json')), null);
    assert.throws(() => loadPerimeter(perimeterFile({ applications: [] })), /aucune application/);
  });
});

describe('reconnaissance des noms', () => {
  const m = createMatcher(PERIMETER);
  const name = (t, o) => m.matchName(t, o)?.app.name || null;

  test('nom exact, casse, accents, séparateurs, alias, mots collés', () => {
    assert.equal(name('orderhub'), 'OrderHub');
    assert.equal(name('Order-Hub'), 'OrderHub');
    assert.equal(name('ORH'), 'OrderHub');
    assert.equal(name('gestion commerciale entreprises'), 'Gestion Commerciale Entreprises');
    assert.equal(name('BillingEngine'), 'Billing Engine');
    assert.equal(name('AUID-0042'), 'Billing Engine');
  });
  test('fautes de frappe', () => {
    assert.equal(name('OderHub'), 'OrderHub');
    assert.equal(name('Biling Engine'), 'Billing Engine');
  });
  test('stricte (import APM) : la faute ne passe pas', () => {
    assert.equal(name('OderHub', { minScore: 0.95 }), null);
    assert.equal(name('Order Hub', { minScore: 0.95 }), 'OrderHub');
  });
  test('pas de faux positif sur des noms voisins ou courts', () => {
    assert.equal(name('Altos'), null); // 4 lettres : pas de recherche de faute
    assert.equal(name('Orchestrator'), null);
    assert.equal(name('Billing'), null); // nom incomplet isolé : seulement dans un texte
  });
  test('nom renvoyé par l\'IA avec du texte autour', () => {
    assert.equal(m.resolveAppName('OrderHub (ORH)').app.name, 'OrderHub');
    assert.equal(m.resolveAppName('le batch de nuit ORH').app.name, 'OrderHub');
    assert.equal(m.resolveAppName('OrderHub et Alto'), null); // deux applications : ambigu
  });
});

describe('recherche dans un texte', () => {
  const m = createMatcher(PERIMETER);
  const kinds = (text) => Object.fromEntries([...m.scanText(text).entries()].map(([id, l]) => [id, l.map((h) => h.kind).sort()]));

  test('variantes reconnues dans une phrase', () => {
    const r = kinds("Le flux part de l'Oderhub vers la Gestion Commerciale puis la GCE, et ALTO lit la base.");
    assert.deepEqual(r['application:orderhub'], ['faute']);
    assert.deepEqual(r['application:gestion-commerciale-entreprises'], ['partiel', 'sigle']);
    assert.deepEqual(r['application:alto'], ['exact']);
  });
  test('le début du nom complet ne compte pas comme nom incomplet', () => {
    assert.deepEqual(kinds('La Gestion Commerciale Entreprises tourne la nuit.')['application:gestion-commerciale-entreprises'], ['exact']);
  });
  test('un seul mot du nom ("Gestion", "Batch") ne suffit pas', () => {
    assert.deepEqual(kinds('Gestion des incidents du soir'), {});
    const m2 = createMatcher(loadPerimeter(perimeterFile({ applications: ['Batch Comptable'] })));
    assert.equal(m2.scanText('Batch de nuit des créances').size, 0);
    assert.equal(m2.scanText('Le Batch Comptable démarre').size, 1);
  });
  test('un identifiant avec _ ne contient pas le sigle (ORA_ORH n\'est pas OrderHub)', () => {
    assert.deepEqual(kinds('Base ORA_ORH et dossier srv_orh_01'), {});
    assert.equal(m.resolveAppName('ORA_ORH'), null);
  });
  test('mots courants et sigles en minuscules ignorés', () => {
    assert.deepEqual(kinds('la gestion des orh et des alternatives, gce en minuscules'), {});
  });
});

describe('pages du périmètre', () => {
  let repo;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    repo.upsertNode({ type: 'server', key: 'srvorh01', aliases: ['10.20.40.11'], source: 'apm' });
    repo.addEdge({ src: 'application:orderhub', dst: 'server:srvorh01', type: 'runs_on', source: 'apm', confidence: 1 });
  });

  test('nœuds du périmètre marqués et retrouvables par alias', () => {
    assert.equal(repo.getNode('application:orderhub').attrs.perimeter, true);
    assert.equal(repo.resolve('orh')[0].id, 'application:orderhub');
  });

  test('AUID partagé par deux applications : indice faible', () => {
    const shared = loadPerimeter(perimeterFile({ applications: [{ name: 'App Un', auid: 'ECO-1' }, { name: 'App Deux', auid: 'ECO-1' }] }));
    const hits = createMatcher(shared).scanText('Écosystème ECO-1');
    assert.equal(hits.get('application:app-un')[0].score, 0.6);
  });
});

describe('import APM limité au périmètre', () => {
  test('lignes hors périmètre ignorées, nom ramené au nom de référence, noms proches signalés', () => {
    const repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    const records = [
      { App: 'ORDERHUB', Host: 'srvorh01' },
      { App: 'Order Hub', Host: 'srvorh02' },
      { App: 'OderHub', Host: 'srvx01' },
      { App: 'Autre appli', Host: 'srvy01' },
    ];
    const mapping = { entity: 'server', key: 'Host', perimeterColumn: 'App', relations: [{ column: 'App', entity: 'application', type: 'runs_on', direction: 'from', multi: false }] };
    const stats = ingestInventory(repo, { source: 'apm', records, mapping, matcher: createMatcher(PERIMETER) });
    assert.equal(stats.outOfScope, 2);
    assert.deepEqual(stats.nearMisses, ['OderHub -> OrderHub (1 lignes)']);
    const servers = repo.edgesFrom('application:orderhub').map((e) => e.dst).sort();
    assert.deepEqual(servers, ['server:srvorh01', 'server:srvorh02']);
    assert.ok(!repo.getNode('server:srvy01'));
  });
});

describe('marketplace : plusieurs applications dans une cellule', () => {
  test('seules celles du périmètre sont gardées', () => {
    const repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    const records = [
      { Hostname: 'srv1', Application: 'Autre;ORDERHUB' },
      { Hostname: 'srv2', Application: 'Autre;Encore' },
    ];
    const mapping = { entity: 'server', key: 'Hostname', perimeterColumn: 'Application', relations: [{ column: 'Application', entity: 'application', type: 'runs_on', direction: 'from' }] };
    const stats = ingestInventory(repo, { source: 'marketplace', records, mapping, matcher: createMatcher(PERIMETER) });
    assert.equal(stats.outOfScope, 1);
    assert.deepEqual(repo.edgesFrom('application:orderhub').map((e) => e.dst), ['server:srv1']);
    assert.ok(!repo.getNode('application:autre'));
  });
});

describe('liens inactifs et périmètre', () => {
  test('inactive llm runs_on does not make a server belong to the app', () => {
    const repo = createRepo(openStore(':memory:'));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-per-')), 'perimeter.json');
    fs.writeFileSync(file, JSON.stringify({ applications: ['OrderHub'] }));
    const perimeter = loadPerimeter(file);
    ensurePerimeterNodes(repo, perimeter);
    const real = repo.upsertNode({ type: 'server', key: 'srvorh01', name: 'srvorh01', source: 'apm' });
    const ghost = repo.upsertNode({ type: 'server', key: 'srvghost', name: 'srvghost', source: 'llm' });
    repo.addEdge({ src: 'application:orderhub', dst: real, type: 'runs_on', source: 'apm' });
    repo.addEdge({ src: 'application:orderhub', dst: ghost, type: 'runs_on', source: 'llm', sourceRef: 'p1', attrs: { trust: 'toValidate' } });
    const m = createMatcher(perimeter, repo);
    assert.deepEqual([...m.apps[0].servers], [real]);
  });
});
