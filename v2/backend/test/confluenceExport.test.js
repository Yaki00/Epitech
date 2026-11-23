'use strict';
const assert = require('assert').strict;
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { findPageDirs, readExportPages, normalizeMetadata, exportHash, analyseEntry, loadDiagrams } = require('../src/ingest/confluenceExport');
const { parseViewPage } = require('../src/parse/confluence/viewHtml');
const { ingestConfluencePage } = require('../src/ingest/confluence');
const { impactOf } = require('../src/graph/impact');

const ROOT = path.join(__dirname, 'fixtures', 'confluence-export');
const entries = () => [...readExportPages(ROOT)];
const byTitle = (title) => entries().find((e) => e.p && e.p.title === title);

describe('export Confluence local (dossier par page)', () => {
  test('trouve les dossiers de page à toute profondeur, la clé est le pageId', () => {
    assert.equal(findPageDirs(ROOT).length, 3);
    const ok = entries().filter((e) => !e.error);
    assert.deepEqual(ok.map((e) => e.p.id).sort(), ['9001109', '9001200']);
  });
  test('une page illisible remonte une erreur sans arrêter le parcours', () => {
    const bad = entries().filter((e) => e.error);
    assert.equal(bad.length, 1);
    assert.match(bad[0].ref, /0099 - Page cassee/);
  });
  test('métadonnées : version 0 = inconnue, version objet, ancêtres, labels', () => {
    assert.equal(normalizeMetadata({ pageId: 5, version: 0 }).version, null);
    const lc = byTitle('OrderHub - Servers').p;
    assert.equal(lc.version, 7);
    assert.equal(lc.parentId, '9001150');
    assert.deepEqual(lc.ancestors, ['Home', 'OrderHub']);
    assert.deepEqual(lc.labels, ['orderhub', 'servers']);
  });
  test('les entités du fetcher (téléphones pris pour des IP) sont ignorées', () => {
    const e = byTitle('Paris Service Delivery');
    const page = analyseEntry(e);
    assert.deepEqual(page.entities.ips, []);
  });
  test("l'empreinte change si le storage change", () => {
    assert.notEqual(exportHash({ html: 'a', storage: null }), exportHash({ html: 'a', storage: 'b' }));
  });
});

describe('page.html (format rendu)', () => {
  test('sections par titres, avec ancre', () => {
    const page = analyseEntry(byTitle('Paris Service Delivery'));
    assert.deepEqual(
      page.sections.map((s) => [s.heading, s.anchor]),
      [['Contacts - How to contact us ?', 'ParisServiceDelivery-Contacts-Howtocontactus?']]
    );
  });
  test('tableau : en-têtes en <th>, ligne barrée retirée', () => {
    const page = analyseEntry(byTitle('Paris Service Delivery'));
    assert.equal(page.tables.length, 1);
    assert.deepEqual(page.tables[0].headers, ['Name', 'Phone', 'Business Line', 'email']);
    assert.deepEqual(page.tables[0].rows.map((r) => r.Name), ['Jean Martin', 'Claire Durand']);
    assert.equal(page.obsoleteFragments, 4);
    assert.ok(!page.text.includes('Paul Ancien'));
  });
  test('serveurs, IP, diagramme, image, Jira, lien de page', () => {
    const e = byTitle('OrderHub - Servers');
    const page = analyseEntry(e);
    assert.deepEqual(page.entities.ips, ['10.20.40.11']); // 10.20.40.99 est barrée
    assert.ok(page.entities.hosts.includes('srvorh01.dom.example.com'));
    assert.ok(page.text.includes('/data/orderhub/logs')); // contenu d'un bloc repliable
    assert.deepEqual(page.diagrams.map((d) => d.name), ['archi-orderhub']);
    assert.deepEqual(page.jiraKeys.sort(), ['ORH-42', 'ORH-43']); // ORH-43 vient du storage
    const img = page.images.filter((i) => i.kind === 'attachment');
    assert.equal(img.length, 1); // l'émoticône est ignorée
    assert.equal(img[0].filename, 'schema flux.png');
    assert.equal(img[0].section, 'Architecture');
    assert.equal(page.pageLinks[0].pageId, '9001150');
    assert.equal(e.imageFiles.length, 1);
  });
  test('script et style ne polluent pas le texte', () => {
    const page = parseViewPage('<p>a</p><script>var x = "10.1.1.1";</script><style>.x{}</style>', { title: 'T' });
    assert.equal(page.text, 'T\na');
    assert.deepEqual(page.entities.ips, []);
  });
  test('tableau clé / valeur (1re colonne en <th>)', () => {
    const page = parseViewPage('<table><tr><th>Serveur</th><td>srv01</td></tr><tr><th>IP</th><td>10.0.0.1</td></tr></table>', {});
    assert.deepEqual(page.tables[0].rows, [
      { col1: 'Serveur', col2: 'srv01' },
      { col1: 'IP', col2: '10.0.0.1' },
    ]);
  });
});

describe('export -> graphe', () => {
  test('mentions, application documentée (titre et page parente), lien draw.io', () => {
    const repo = createRepo(openStore(':memory:'));
    repo.upsertNode({ type: 'application', key: 'OrderHub', name: 'OrderHub', source: 'apm' });
    repo.upsertNode({ type: 'server', key: 'srvorh01', aliases: ['10.20.40.11'], source: 'marketplace' });
    repo.upsertNode({ type: 'database', key: 'ORA_ORH', name: 'ORA_ORH', source: 'test' });

    const e = byTitle('OrderHub - Servers');
    const page = analyseEntry(e);
    const diagrams = loadDiagrams(ROOT, e, page);
    assert.deepEqual(diagrams.missing, []);
    const stats = ingestConfluencePage(repo, page, { drawioResults: diagrams.results, url: e.p.url });

    assert.equal(stats.diagramLinks, 1);
    const docId = 'document:confluence-9001200';
    const mentions = repo.edgesFrom(docId).filter((x) => x.type === 'mentions');
    assert.deepEqual([...new Set(mentions.map((x) => x.dst))], ['server:srvorh01']);
    assert.equal(mentions[0].attrs.pageUpdatedAt, '2024-03-12T10:00:00.000+01:00');
    const doc = repo.edgesFrom('application:orderhub').find((x) => x.type === 'documented_in');
    assert.equal(doc.dst, docId);
    assert.equal(doc.confidence, 0.7); // début du titre "OrderHub - Servers"
    assert.deepEqual(impactOf(repo, 'database:ora_orh').items.map((i) => i.id), ['application:orderhub']);
  });
});
