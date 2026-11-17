'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { parseCsv, columnLetter, columnIndex } = require('../src/lib/csv');
const { ingestInventory, resolveMapping } = require('../src/ingest/inventory');

const apmMapping = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/mappings.example.json'), 'utf8')).apm;

/** Export APM factice de 89 colonnes (A à CK), séparateur ";" comme un export Excel FR. */
function fakeApmCsv(rows) {
  const width = columnIndex('CK') + 1;
  const header = Array.from({ length: width }, (_, i) => `Champ ${columnLetter(i)}`);
  header[columnIndex('A')] = 'Application name';
  header[columnIndex('E')] = 'OS host';
  header[columnIndex('K')] = 'OS';
  header[columnIndex('L')] = 'OS'; // en-tête en double : ne doit pas écraser K
  const lines = [header];
  for (const r of rows) {
    const line = Array(width).fill('');
    for (const [letter, value] of Object.entries(r)) line[columnIndex(letter)] = value;
    lines.push(line);
  }
  return lines.map((l) => l.map((v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(';')).join('\r\n');
}

const csv = fakeApmCsv([
  { A: 'OrderHub', B: 'AUID-0042', D: 'IV2', E: 'srvohb01', F: '10.20.40.11 10.20.40.12', I: 'Application server', K: 'Linux', L: 'RHEL 8.10', AC: 'France', AH: 'Standard', AI: 'C2', CH: '32', CI: '2.4 GHz', CJ: '8', CK: 'srvohb01.dom.example.com' },
  { A: 'Billing', B: 'AUID-0042', D: 'IV1', E: 'srvohb01', F: '10.20.40.11', K: 'Linux', L: 'RHEL 8.10', CK: 'srvohb01.dom.example.com' },
  { A: 'Billing', B: 'AUID-0042', D: 'IV1', E: 'srvbil02', F: '10.20.40.20', K: 'Windows', L: '2019', AI: 'C3', CK: 'srvbil02.dom.example.com' },
  { A: 'Orpheline', E: '' },
]);

describe('lettres de colonnes Excel', () => {
  test('aller-retour', () => {
    for (const [i, l] of [[0, 'A'], [25, 'Z'], [26, 'AA'], [33, 'AH'], [88, 'CK']]) {
      assert.equal(columnLetter(i), l);
      assert.equal(columnIndex(l), i);
    }
    assert.equal(columnIndex('Hostname'), -1);
  });
  test('en-têtes en double ou vides rendus uniques', () => {
    const { headers } = parseCsv('OS;OS;;x\n1;2;3;4');
    assert.deepEqual(headers, ['OS', 'OS (B)', 'Colonne C', 'x']);
  });
  test('un nom d\'en-tête existant reste prioritaire sur une lettre', () => {
    const { mapping, resolved } = resolveMapping({ key: 'OS', attrs: { a: 'CK' } }, ['OS', 'CK']);
    assert.equal(mapping.key, 'OS');
    assert.equal(mapping.attrs.a, 'CK');
    assert.deepEqual(resolved, []);
  });
});

describe('export APM des serveurs', () => {
  let repo;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    const { records, headers } = parseCsv(csv);
    const stats = ingestInventory(repo, { source: 'apm', records, headers, mapping: apmMapping });
    assert.equal(stats.skipped, 1); // ligne sans OS host
    assert.equal(stats.errors, 0);
  });

  test('serveur : attributs demandés, version OS lue en colonne L malgré l\'en-tête en double', () => {
    const s = repo.getNode('server:srvohb01');
    assert.equal(s.attrs.provisioner, 'IV1'); // dernière ligne lue pour ce serveur
    assert.equal(s.attrs.os, 'Linux');
    assert.equal(s.attrs.osVersion, 'RHEL 8.10');
    assert.equal(s.attrs.fqdn, 'srvohb01.dom.example.com');
    assert.equal(s.attrs.country, 'France');
    assert.equal(s.attrs.ram, '32');
    assert.equal(s.attrs.cpu, '2.4 GHz');
    assert.equal(s.attrs.cpuCores, '8');
    assert.equal(s.attrs.usedFor, 'Application server');
  });

  test('recherche par FQDN et par chaque IP de la liste', () => {
    assert.equal(repo.resolve('srvohb01.dom.example.com')[0].id, 'server:srvohb01');
    assert.equal(repo.resolve('10.20.40.12')[0].id, 'server:srvohb01');
  });

  test('application : AUID, profil, confidentialité et serveurs hébergés', () => {
    const app = repo.getNode('application:orderhub');
    assert.equal(app.attrs.auid, 'AUID-0042');
    assert.equal(app.attrs.profile, 'Standard');
    assert.equal(app.attrs.confidentiality, 'C2');
    const billing = repo.edgesFrom('application:billing').filter((e) => e.type === 'runs_on').map((e) => e.dst).sort();
    assert.deepEqual(billing, ['server:srvbil02', 'server:srvohb01']);
    assert.equal(repo.getNode('application:billing').attrs.confidentiality, 'C3');
  });

  test('lettre hors du fichier = erreur explicite', () => {
    const { records, headers } = parseCsv('a;b\n1;2');
    assert.throws(() => ingestInventory(repo, { source: 'apm', records, headers, mapping: apmMapping }), /Colonnes absentes.*CK/);
  });
});
