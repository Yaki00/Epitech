'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { architectureScore, auditArchitecturePage, pageEnvironment } = require('../src/perimeter/architecture');
const { extractEntities } = require('../src/resolve/entities');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-archi-')), 'perimeter.json');
fs.writeFileSync(file, JSON.stringify({ applications: ['OrderHub', 'Alto'] }));
const PERIMETER = loadPerimeter(file);

const noEntities = { hosts: [], ips: [] };

describe("reconnaître une page d'architecture", () => {
  test('par le titre, y compris un DAT', () => {
    assert.ok(architectureScore({ title: 'OrderHub - Architecture technique' }).score >= 0.8);
    assert.ok(architectureScore({ title: 'DAT OrderHub v3' }).score >= 0.8);
    assert.ok(architectureScore({ title: 'Serveurs de production' }).score >= 0.8);
  });
  test('par un tableau serveurs / IP, sans mot-clé dans le titre', () => {
    const r = architectureScore({ title: 'Liste', tables: [{ headers: ['Hostname', 'Adresse IP', 'Rôle'], rows: [] }] });
    assert.equal(r.score, 0.7);
  });
  test('pas une page de contacts ni une page quelconque', () => {
    assert.ok(architectureScore({ title: 'Contacts', tables: [{ headers: ['Nom', 'Téléphone', 'Adresse'], rows: [] }] }).score < 0.6);
    assert.ok(architectureScore({ title: 'Réunion du lundi' }).score < 0.6);
  });
  test('page parente seule : pas suffisant', () => {
    assert.ok(architectureScore({ title: 'Ports ouverts' }, { ancestors: ['Architecture'] }).score < 0.6);
  });
  test('environnement de la page', () => {
    assert.equal(pageEnvironment('Serveurs de production'), 'prod');
    assert.equal(pageEnvironment('Serveurs PRD'), 'prod');
    assert.equal(pageEnvironment('Architecture recette'), 'nonprod');
    assert.equal(pageEnvironment('Architecture préproduction'), 'nonprod');
    assert.equal(pageEnvironment('Architecture'), null);
  });
});

describe("contrôle d'une page d'architecture", () => {
  let repo;
  let m;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    const srv = (key, ip, environment, app) => {
      repo.upsertNode({ type: 'server', key, attrs: { ip, environment }, aliases: [ip], source: 'apm' });
      repo.addEdge({ src: `application:${app}`, dst: `server:${key}`, type: 'runs_on', source: 'apm', confidence: 1 });
    };
    srv('ohbprd01', '10.1.0.1', 'PROD', 'orderhub');
    srv('ohbprd02', '10.1.0.2', 'PROD', 'orderhub');
    srv('ohbrec01', '10.2.0.1', 'STG', 'orderhub');
    srv('altoprd01', '10.3.0.1', 'PROD', 'alto');
    m = createMatcher(PERIMETER, repo);
  });

  // serveurs cités comme le rendrait la vérification d'une lecture : nom, nœud rapproché, présence à l'inventaire
  const citedOf = (...names) =>
    names.map((spec) => {
      const [name, ip = null] = Array.isArray(spec) ? spec : [spec];
      const node = repo.resolve(name).find((n) => n.type === 'server');
      return { nodeId: node ? node.id : null, name: node ? node.name : name, ip, env: null, status: 'active', inInventory: Boolean(node), corroborated: false, evidence: name };
    });

  const page = (title, rows, text = '') => {
    const tableText = rows.map((r) => `${r.Serveur} ${r.IP}`).join('\n');
    return {
      title,
      updatedAt: '2020-01-15T10:00:00Z',
      sections: [{ heading: 'Serveurs', text: `${text}\n${tableText}` }],
      tables: [{ headers: ['Serveur', 'IP', 'Rôle'], rows }],
      entities: extractEntities(`${text}\n${tableText}`),
      diagrams: [],
    };
  };

  test('ipMismatch comes from the reading ip', () => {
    const p = page('Serveurs', []);
    const a = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2026-11-18'), cited: citedOf(['ohbprd01', '10.1.0.1'], ['ohbprd02', '10.1.0.77'], 'ohbrec01'), env: null, topics: [] });
    assert.deepEqual(a.ipMismatch, [{ server: 'ohbprd02', page: ['10.1.0.77'], inventory: ['10.1.0.2'] }]);
  });

  test('confirmés, manquants, autre application, inconnus, IP différente', () => {
    const p = page('OrderHub - Serveurs de production', [
      { Serveur: 'OHBPRD01', IP: '10.1.0.1' },
      { Serveur: 'altoprd01', IP: '10.3.0.1' },
      { Serveur: 'vieuxsrv07', IP: '10.9.9.9' },
    ]);
    p.tables[0].rows.push({ Serveur: 'ohbprd02', IP: '10.1.0.99' });
    const cited = citedOf('OHBPRD01', 'altoprd01', 'vieuxsrv07', '10.9.9.9', ['ohbprd02', '10.1.0.99']);
    const a = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2026-11-18'), cited, env: 'PRD', topics: ['servers'] });
    assert.equal(a.environment, 'PRD');
    assert.equal(a.expected, 2); // le serveur de recette n'est pas attendu dans une page de production
    assert.deepEqual(a.confirmed.sort(), ['ohbprd01', 'ohbprd02']);
    assert.deepEqual(a.missing, []);
    assert.equal(a.completeness, 1);
    assert.deepEqual(a.otherApp, [{ server: 'altoprd01', applications: ['Alto'] }]);
    assert.ok(a.unknown.includes('vieuxsrv07'));
    assert.ok(a.unknown.includes('10.9.9.9'));
    assert.ok(!a.unknown.includes('10.1.0.99')); // déjà dans les IP différentes
    assert.deepEqual(a.ipMismatch, [{ server: 'ohbprd02', page: ['10.1.0.99'], inventory: ['10.1.0.2'] }]);
    assert.deepEqual(a.problems.map((x) => x.code), ['otherApp', 'unknown', 'ipMismatch', 'old']);
    assert.match(a.verdict, /autre application/);
    assert.match(a.verdict, /il y a 7 ans/);
  });

  test('page générale : tous les environnements attendus, rubriques absentes listées', () => {
    const p = page('OrderHub - Architecture', [{ Serveur: 'ohbprd01', IP: '10.1.0.1' }], 'Sauvegarde quotidienne. Supervision Naemon. Flux MQ vers la facturation.');
    const a = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2020-02-01'), cited: citedOf('ohbprd01'), env: null, topics: ['servers', 'backup', 'monitoring', 'flows'] });
    assert.equal(a.expected, 3);
    assert.deepEqual(a.missing.sort(), ['ohbprd02', 'ohbrec01']);
    assert.equal(a.completeness, 0.33);
    assert.equal(a.sections.backup, true);
    assert.equal(a.sections.monitoring, true);
    assert.equal(a.sections.flows, true);
    assert.deepEqual([...a.absentSections].sort(), ['contacts', 'databases', 'diagram', 'redundancy']);
  });

  test('page conforme', () => {
    const p = page('OrderHub - Serveurs de production', [
      { Serveur: 'ohbprd01', IP: '10.1.0.1' },
      { Serveur: 'ohbprd02', IP: '10.1.0.2' },
    ]);
    const a = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2020-02-01'), cited: citedOf('ohbprd01', 'ohbprd02'), env: 'PRD', topics: [] });
    assert.equal(a.verdict, 'cohérente avec les inventaires');
    assert.equal(a.ok, true);
  });

  test('audit uses cited servers and env from reading', () => {
    // le texte de la page ne cite rien d'utile : seule la lecture compte
    const p = page('Page sans mot utile', []);
    p.sections = [{ heading: 'x', text: 'ohbprd01 ohbprd02 ohbrec01' }];
    const none = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2020-02-01'), cited: [], env: null, topics: [] });
    assert.equal(none.confirmed.length, 0);
    assert.equal(none.expected, 3);
    const rec = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2020-02-01'), cited: citedOf('ohbrec01'), env: 'STG', topics: [] });
    assert.equal(rec.environment, 'STG');
    assert.equal(rec.expected, 1); // seul le serveur de recette est attendu dans une page STG
    assert.equal(rec.completeness, 1);
    assert.deepEqual(rec.confirmed, ['ohbrec01']);
    const prd = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2020-02-01'), cited: citedOf('ohbprd01'), env: 'PRD', topics: [] });
    assert.equal(prd.environment, 'PRD');
    assert.equal(prd.expected, 2);
    assert.deepEqual(prd.missing, ['ohbprd02']);
    // un serveur hors inventaire cité est inconnu ; l'IP d'un autre serveur du périmètre est signalée
    const odd = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2020-02-01'), cited: [...citedOf('altoprd01'), { nodeId: 'server:nouveau', name: 'nouveau', inInventory: false, status: 'active', evidence: 'nouveau' }], env: null, topics: [] });
    assert.deepEqual(odd.otherApp, [{ server: 'altoprd01', applications: ['Alto'] }]);
    assert.deepEqual(odd.unknown, ['nouveau']);
  });

  test('completeness comes from topics', () => {
    const p = page('Titre quelconque', [], 'Sauvegarde Supervision flux base de donnees');
    const a = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2026-11-18'), cited: [], env: null, topics: ['backup', 'databases'] });
    assert.equal(a.sections.backup, true);
    assert.equal(a.sections.databases, true);
    assert.equal(a.sections.flows, false); // le mot « flux » est dans le texte, mais l'IA ne l'a pas retenu
    assert.equal(a.sections.monitoring, false);
    assert.equal(a.sections.diagram, false);
    assert.ok(a.absentSections.includes('flows'));
    assert.ok(!a.absentSections.includes('backup'));
    p.diagrams = [{ name: 'schema' }];
    const b = auditArchitecturePage(repo, m, p, 'application:orderhub', { now: Date.parse('2026-11-18'), cited: [], env: null, topics: [] });
    assert.equal(b.sections.diagram, true);
  });
});
