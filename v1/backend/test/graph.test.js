'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { ingestInventory } = require('../src/ingest/inventory');
const { ingestConfluencePage } = require('../src/ingest/confluence');
const { parseStoragePage } = require('../src/parse/confluence/storage');
const { parseDrawio } = require('../src/parse/confluence/drawio');
const { impactOf, dependenciesOf, neighborhood } = require('../src/graph/impact');
const { applyRelations, sanitize } = require('../src/enrich/relations');

const marketplace = [
  { Hostname: 'SRVALTO01.dom.example.com', IP: '10.20.30.41', RAM: '16', Application: 'ALTO' },
  { Hostname: 'srvalto02', IP: '10.20.30.42', RAM: '8', Application: 'ALTO' },
  { Hostname: 'srvbrief01', IP: '10.20.30.50', RAM: '32', Application: 'BRIEF;HERA' },
  { Hostname: '', IP: '', RAM: '', Application: '' },
];
const mpMapping = {
  entity: 'server',
  key: 'Hostname',
  aliases: ['IP'],
  attrs: { ip: 'IP', ram: 'RAM' },
  relations: [{ column: 'Application', entity: 'application', type: 'runs_on', direction: 'from' }],
};

let repo;
beforeEach(() => {
  repo = createRepo(openStore(':memory:'));
  ingestInventory(repo, { source: 'marketplace', records: marketplace, mapping: mpMapping });
  repo.upsertNode({ type: 'database', key: 'ORA_ALTO', name: 'ORA_ALTO', source: 'test' });
});

describe('inventaire', () => {
  test('nœuds, alias FQDN/IP et lignes vides ignorées', () => {
    assert.deepEqual(repo.countByType(), { application: 3, database: 1, server: 3 });
    assert.equal(repo.resolve('10.20.30.41')[0].id, 'server:srvalto01');
    assert.equal(repo.resolve('srvalto01.dom.example.com')[0].id, 'server:srvalto01');
    assert.equal(repo.getNode('server:srvalto01').attrs.ram, '16');
  });
  test('idempotent : relancer ne duplique rien', () => {
    ingestInventory(repo, { source: 'marketplace', records: marketplace, mapping: mpMapping });
    assert.equal(repo.edgesFrom('application:alto').length, 2);
  });
  test('colonne absente = erreur explicite', () => {
    assert.throws(() => ingestInventory(repo, { source: 'x', records: [{ A: 1 }], mapping: { entity: 'server', key: 'Hostname' } }), /Colonnes absentes/);
  });
});

describe('impact', () => {
  test('si srvbrief01 tombe, BRIEF et HERA sont impactées', () => {
    const r = impactOf(repo, 'server:srvbrief01');
    assert.deepEqual(r.items.map((i) => i.id).sort(), ['application:brief', 'application:hera']);
    assert.equal(r.items[0].via.source, 'marketplace');
    assert.ok(r.elements.edges.length === 2);
  });
  test('dépendances de ALTO', () => {
    const r = dependenciesOf(repo, 'application:alto');
    assert.deepEqual(r.byType, { server: ['server:srvalto01', 'server:srvalto02'] });
  });
  test('propagation multi-niveaux et filtre de confiance', () => {
    repo.addEdge({ src: 'application:hera', dst: 'application:alto', type: 'calls', source: 'llm', confidence: 0.4 });
    assert.ok(!impactOf(repo, 'server:srvalto01').items.some((i) => i.id === 'application:hera'));
    const low = impactOf(repo, 'server:srvalto01', { minConfidence: 0.3 });
    const hera = low.items.find((i) => i.id === 'application:hera');
    assert.equal(hera.depth, 2);
  });
  test('id inconnu = null', () => assert.equal(impactOf(repo, 'server:nope'), null));
});

describe('Confluence -> graphe', () => {
  test('mentions, documentation et liens draw.io entre entités connues', () => {
    const xml = fs.readFileSync(path.join(__dirname, 'fixtures/page-alto.xml'), 'utf8');
    const page = parseStoragePage(xml, { id: '42', title: 'ALTO' });
    const drawio = parseDrawio(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="ALTO" vertex="1" parent="1"/><mxCell id="b" value="ORA_ALTO" vertex="1" parent="1"/>
      <mxCell id="c" value="Inconnu" vertex="1" parent="1"/>
      <mxCell id="e" edge="1" source="a" target="b" parent="1"/><mxCell id="f" edge="1" source="a" target="c" parent="1"/>
    </root></mxGraphModel>`);
    const stats = ingestConfluencePage(repo, page, { drawioResults: [drawio] });
    assert.ok(stats.mentions >= 2);
    assert.equal(stats.diagramLinks, 1);
    assert.ok(stats.unresolved.includes('ALTO -> Inconnu'));
    const uses = repo.edgesFrom('application:alto').find((e) => e.type === 'uses_db');
    assert.equal(uses.dst, 'database:ora_alto');
    assert.equal(uses.source, 'drawio');
    // si la base tombe, ALTO est impactée ; la page Confluence (mentions) ne propage pas
    const imp = impactOf(repo, 'database:ora_alto');
    assert.deepEqual(imp.items.map((i) => i.id), ['application:alto']);
    assert.ok(neighborhood(repo, 'application:alto').nodes.length >= 4);
  });
});

describe('relations IA', () => {
  test('sanitize filtre types inconnus, faible confiance et doublons', () => {
    const s = sanitize({
      entities: [{ name: 'MQ_ALTO', type: 'queue' }, { name: 'x', type: 'bizarre' }],
      relations: [
        { from: 'ALTO', to: 'MQ_ALTO', type: 'writes_to', confidence: 0.9 },
        { from: 'alto', to: 'mq_alto', type: 'writes_to', confidence: 1 },
        { from: 'ALTO', to: 'Y', type: 'invente', confidence: 1 },
        { from: 'ALTO', to: 'Z', type: 'calls', confidence: 0.2 },
      ],
    });
    assert.equal(s.relations.length, 1);
    assert.equal(s.entities[1].type, 'other');
  });
  test('applyRelations réutilise les entités connues et crée les autres', () => {
    const n = applyRelations(
      repo,
      { entities: [{ name: 'MQ_ALTO', type: 'queue' }], relations: [{ from: 'alto', to: 'MQ_ALTO', type: 'writes_to', confidence: 1, evidence: 'ALTO publie dans MQ_ALTO' }] },
      { sourceRef: '42' }
    );
    assert.equal(n, 1);
    const e = repo.edgesFrom('application:alto').find((x) => x.type === 'writes_to');
    assert.equal(e.dst, 'queue:mq_alto');
    assert.equal(e.confidence, 0.8);
    assert.equal(repo.getNode('queue:mq_alto').attrs.fromLlm, true);
  });
});

describe('suivi des synchros', () => {
  test('runs et erreurs', () => {
    const id = repo.startRun('test');
    repo.recordError(id, { source: 'test', ref: 1, step: 'parse', message: 'boom' });
    repo.finishRun(id, { status: 'partial', stats: { a: 1 } });
    assert.equal(repo.lastRuns(1)[0].status, 'partial');
    assert.equal(repo.errorsOfRun(id)[0].message, 'boom');
  });
});
