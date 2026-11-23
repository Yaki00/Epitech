'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher, ensurePerimeterNodes, editDistance, acronym } = require('../src/perimeter/perimeter');
const { ingestInventory } = require('../src/ingest/inventory');
const { applyRelations, buildMessages, triagePage } = require('../src/enrich/relations');

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

  test('titre, page parente et serveur connu', () => {
    const m = createMatcher(PERIMETER, repo);
    const page = {
      title: 'Procédure de redémarrage',
      ancestors: ['Home', 'Oderhub'],
      sections: [{ heading: 'Serveurs', text: 'Redémarrer 10.20.40.11 puis vérifier les logs.' }],
      entities: { hosts: [], ips: ['10.20.40.11'] },
    };
    const [r] = m.scanPage(page);
    assert.equal(r.name, 'OrderHub');
    assert.ok(r.reasons.includes('serveur srvorh01'));
    assert.ok(r.reasons.some((x) => x.startsWith('page parente')));
    assert.deepEqual(r.spellings, ['Oderhub']);
    assert.ok(r.score >= 0.85 && r.score <= 0.95);
  });

  test('page sans rapport : rien', () => {
    const m = createMatcher(PERIMETER, repo);
    assert.deepEqual(m.scanPage({ title: 'Charte graphique', sections: [{ text: 'Couleurs et logos.' }], entities: { hosts: [], ips: [] } }), []);
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

describe('IA avec périmètre', () => {
  let repo;
  let m;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    repo.upsertNode({ type: 'application', key: 'Hors Liste', source: 'marketplace' });
    m = createMatcher(PERIMETER, repo);
  });

  test('le prompt liste le périmètre, les applis de la page et la consigne d\'ignorer le reste', () => {
    const scope = { apps: PERIMETER.applications, ignoreOthers: true, pageApps: ['OrderHub'], knownServers: ['srvorh01'] };
    const [sys, user] = buildMessages({ pageTitle: 'P', section: { heading: 'S', text: 'x' }, hints: { ips: [], hosts: [], paths: [] }, scope });
    assert.match(sys.content, /- OrderHub \(aussi écrit : ORH\)/);
    assert.match(sys.content, /AUCUNE relation/);
    assert.match(user.content, /concerne probablement : OrderHub/);
    assert.match(user.content, /srvorh01/);
  });

  test('nom mal écrit corrigé, applications hors périmètre écartées, serveurs gardés', () => {
    const counters = { dropped: 0, renamed: 0 };
    const extracted = {
      entities: [
        { name: 'Oderhub', type: 'application' },
        { name: 'srvorh09', type: 'server' },
        { name: 'Hors Liste', type: 'application' },
        { name: 'Inconnue', type: 'application' },
        { name: 'ORA_BILL', type: 'database' },
      ],
      relations: [
        { from: 'Oderhub', to: 'srvorh09', type: 'runs_on', confidence: 1 },
        { from: 'Oderhub', to: 'Hors Liste', type: 'calls', confidence: 1 },
        { from: 'Inconnue', to: 'ORA_BILL', type: 'uses_db', confidence: 1 },
        { from: 'Billing Engine', to: 'ORA_BILL', type: 'uses_db', confidence: 0.5 },
      ],
    };
    const n = applyRelations(repo, extracted, { sourceRef: 'p1', matcher: m, counters });
    assert.equal(n, 2);
    assert.deepEqual(counters, { dropped: 2, renamed: 2 });
    assert.deepEqual(repo.edgesFrom('application:orderhub').map((e) => e.dst), ['server:srvorh09']);
    assert.equal(repo.edgesFrom('application:billing-engine')[0].confidence, 0.4);
    assert.ok(!repo.getNode('application:inconnue'));
  });

  test('une base dont le nom ressemble à un sigle du périmètre reste une base', () => {
    const counters = { dropped: 0, renamed: 0 };
    const extracted = { entities: [{ name: 'OrderHub', type: 'application' }, { name: 'ORH', type: 'database' }], relations: [{ from: 'OrderHub', to: 'ORH', type: 'uses_db', confidence: 1 }] };
    assert.equal(applyRelations(repo, extracted, { sourceRef: 'p', matcher: m, counters }), 1);
    assert.equal(repo.edgesFrom('application:orderhub')[0].dst, 'database:orh');
  });

  test('sans périmètre : comportement d\'origine (application inconnue créée)', () => {
    applyRelations(repo, { entities: [{ name: 'Inconnue', type: 'application' }], relations: [{ from: 'Inconnue', to: 'Hors Liste', type: 'calls', confidence: 1 }] }, { sourceRef: 'p' });
    assert.equal(repo.getNode('application:inconnue').attrs.fromLlm, true);
  });

  test('tri IA : réponses peu sûres filtrées', async () => {
    let sent;
    const llm = {
      chatJson: async (req) => {
        sent = req;
        return { applications: [{ name: 'OrderHub', confidence: 0.9, evidence: 'le batch de commandes' }, { name: 'Alto', confidence: 0.3 }] };
      },
    };
    const r = await triagePage(llm, { title: 'Batch de nuit', ancestors: ['Home'], text: 'Le batch de commandes…', scope: { apps: PERIMETER.applications } });
    assert.deepEqual(r.map((x) => x.name), ['OrderHub']);
    assert.match(sent.messages[0].content, /Billing Engine/);
    assert.equal(sent.task, 'extract');
  });
});

describe('application retrouvée par ses serveurs', () => {
  let repo;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    // noms qui ne suivent aucun motif de nom de serveur : seule la liste connue permet de les repérer
    repo.upsertNode({ type: 'server', key: 'PARAPPX1', attrs: { fqdn: 'parappx1.dom.example.com', ip: '10.9.9.1' }, source: 'apm' });
    repo.upsertNode({ type: 'server', key: 'PARAPPX2', source: 'apm' });
    repo.upsertNode({ type: 'server', key: 'MUTUSRV', source: 'apm' });
    repo.addEdge({ src: 'application:orderhub', dst: 'server:parappx1', type: 'runs_on', source: 'apm', confidence: 1 });
    repo.addEdge({ src: 'application:orderhub', dst: 'server:parappx2', type: 'runs_on', source: 'apm', confidence: 1 });
    repo.addEdge({ src: 'application:orderhub', dst: 'server:mutusrv', type: 'runs_on', source: 'apm', confidence: 1 });
    repo.addEdge({ src: 'application:alto', dst: 'server:mutusrv', type: 'runs_on', source: 'apm', confidence: 1 });
  });
  const page = (text) => ({ title: 'Procédure', sections: [{ text }], entities: { hosts: [], ips: [] } });

  test('nom court, FQDN ou IP repérés sans motif', () => {
    const m = createMatcher(PERIMETER, repo);
    for (const t of ['Redémarrer PARAPPX1 le soir', 'voir parappx1.dom.example.com', 'ping 10.9.9.1']) {
      const [r] = m.scanPage(page(t));
      assert.equal(r.name, 'OrderHub', t);
      assert.equal(r.score, 0.85);
    }
  });
  test('deux serveurs propres : indice plus fort', () => {
    const [r] = createMatcher(PERIMETER, repo).scanPage(page('PARAPPX1 et PARAPPX2'));
    assert.ok(r.score >= 0.9);
  });
  test('serveur partagé : indice faible pour chaque application', () => {
    const r = createMatcher(PERIMETER, repo).scanPage(page('Arrêt de MUTUSRV'));
    assert.deepEqual(r.map((x) => [x.name, x.score]).sort(), [['Alto', 0.6], ['OrderHub', 0.6]]);
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
