'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { parseLlmJson, validateShape } = require('../src/lib/json');
const { parseCsv } = require('../src/lib/csv');
const { classifyToken, extractEntities, extractIps, canonicalHost, hostAliases } = require('../src/resolve/entities');
const { resolveInputFile } = require('../src/ingest/inventory');
const os = require('os');
const { parseStoragePage } = require('../src/parse/confluence/storage');
const { parseDrawio } = require('../src/parse/confluence/drawio');

describe('parseLlmJson', () => {
  test('JSON direct', () => assert.deepEqual(parseLlmJson('{"a":1}'), { a: 1 }));
  test('bloc ```json', () => assert.deepEqual(parseLlmJson('Voici :\n```json\n{"a":2}\n```\nVoilà'), { a: 2 }));
  test('texte avec accolades autour (la regex gourmande échouait ici)', () => {
    assert.deepEqual(parseLlmJson('Résultat {"a":3} et aussi {"b":4} fin'), { a: 3 });
  });
  test('accolade dans une chaîne', () => assert.deepEqual(parseLlmJson('x {"t":"a}b"} y'), { t: 'a}b' }));
  test('balises <think> retirées', () => assert.deepEqual(parseLlmJson('<think>{faux}</think>{"ok":true}'), { ok: true }));
  test('erreur explicite si rien', () => assert.throws(() => parseLlmJson('pas de json'), /JSON introuvable/));
  test('validateShape', () => {
    assert.deepEqual(validateShape({ a: [], b: 'x' }, { a: 'array', b: 'string', 'c?': 'number' }), []);
    assert.equal(validateShape({ a: 'x' }, { a: 'array', b: 'string' }).length, 2);
  });
});

describe('parseCsv', () => {
  test('séparateur ; , BOM, guillemets et retour ligne dans un champ', () => {
    const { headers, records, delimiter } = parseCsv('\uFEFFHostname;IP;Note\r\nsrv01;10.0.0.1;"a;b"\r\nsrv02;10.0.0.2;"ligne1\nligne2 ""cité"""\r\n');
    assert.equal(delimiter, ';');
    assert.deepEqual(headers, ['Hostname', 'IP', 'Note']);
    assert.equal(records.length, 2);
    assert.equal(records[0].Note, 'a;b');
    assert.equal(records[1].Note, 'ligne1\nligne2 "cité"');
  });
  test('séparateur virgule', () => assert.equal(parseCsv('a,b\n1,2').records[0].b, '2'));
});

describe('entités', () => {
  test('classifyToken : règles avant IA', () => {
    assert.equal(classifyToken('10.1.2.3'), 'ip');
    assert.equal(classifyToken('/data/app'), 'filesystem');
    assert.equal(classifyToken('\\\\partage\\x'), 'filesystem');
    assert.equal(classifyToken('D:\\apps'), 'filesystem');
    assert.equal(classifyToken('srv01.dom.example.com'), 'host');
    assert.equal(classifyToken('https://x.y'), 'url');
    assert.equal(classifyToken('srv01'), 'unknown');
  });
  test('canonicalHost / alias', () => {
    assert.equal(canonicalHost('SRV01.Dom.Example.com'), 'srv01');
    assert.deepEqual(hostAliases('SRV01.dom.example.com').sort(), ['srv01', 'srv01.dom.example.com']);
  });
  test('extractEntities ignore les noms de fichiers et sépare les URL', () => {
    const e = extractEntities('Voir https://wiki.dom.example.com/x, srv01.dom.example.com 10.0.0.9 et schema.archi.png');
    assert.deepEqual(e.ips, ['10.0.0.9']);
    assert.deepEqual(e.hosts, ['srv01.dom.example.com']);
    assert.equal(e.urls.length, 1);
  });
  test('motif de nom court configurable', () => {
    process.env.HOST_SHORTNAME_PATTERN = '^srv[a-z]+\\d{2}$';
    assert.ok(extractEntities('installé sur srvalto01').hosts.includes('srvalto01'));
    delete process.env.HOST_SHORTNAME_PATTERN;
  });
});

describe('page Confluence (storage)', () => {
  const xml = fs.readFileSync(path.join(__dirname, 'fixtures/page-alto.xml'), 'utf8');
  const page = parseStoragePage(xml, { id: '42', title: 'ALTO', spaceKey: 'INFRA' });

  test('sections découpées par titres', () => {
    assert.deepEqual(page.sections.map((s) => s.heading), ['Architecture ALTO', 'Serveurs']);
  });
  test('tableau structuré', () => {
    assert.equal(page.tables.length, 1);
    assert.deepEqual(page.tables[0].headers, ['Serveur', 'IP', 'Rôle']);
    assert.equal(page.tables[0].rows[0]['Rôle'], 'Front & API');
    assert.equal(page.tables[0].section, 'Serveurs');
  });
  test('liens, images, diagrammes, jira', () => {
    assert.deepEqual(page.pageLinks, [{ title: 'BRIEF - Interfaces', spaceKey: 'INFRA' }]);
    assert.deepEqual(page.images, [{ kind: 'attachment', filename: 'flux.png' }]);
    assert.deepEqual(page.diagrams, [{ type: 'drawio', name: 'archi-alto', pageId: undefined }]);
    assert.deepEqual(page.jiraKeys, ['ALTO-123']);
  });
  test('entités extraites et paramètres de macro exclus du texte', () => {
    assert.ok(page.entities.ips.includes('10.20.30.41'));
    assert.ok(page.entities.hosts.includes('srvalto01.dom.example.com'));
    assert.ok(page.entities.paths.includes('/data/alto/logs'));
    assert.ok(!page.text.includes('archi-alto'));
    assert.ok(page.text.includes('curl https://alto.dom.example.com/api'));
  });
});

describe('draw.io', () => {
  const model = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="srv" value="srvalto01" style="swimlane;" vertex="1" parent="1"/>
    <mxCell id="app" value="&lt;b&gt;ALTO&lt;/b&gt;" vertex="1" parent="srv"/>
    <UserObject id="db" label="ORA_ALTO" env="PROD"><mxCell style="shape=cylinder;" vertex="1" parent="1"/></UserObject>
    <mxCell id="e1" edge="1" source="app" target="db" parent="1"/>
    <mxCell id="lbl" value="JDBC" style="edgeLabel;" vertex="1" parent="e1"/>
    <mxCell id="e2" edge="1" source="app" parent="1"/>
  </root></mxGraphModel>`;

  const check = (res) => {
    const p = res.pages[0];
    assert.deepEqual(p.nodes.map((n) => n.label).sort(), ['ALTO', 'ORA_ALTO', 'srvalto01']);
    assert.equal(p.nodes.find((n) => n.id === 'db').shape, 'cylinder');
    assert.deepEqual(p.nodes.find((n) => n.id === 'db').props, { env: 'PROD' });
    const e1 = p.edges.find((e) => e.id === 'e1');
    assert.equal(e1.sourceLabel, 'ALTO');
    assert.equal(e1.targetLabel, 'ORA_ALTO');
    assert.equal(e1.label, 'JDBC');
    assert.equal(p.edges.find((e) => e.id === 'e2').dangling, true);
    assert.deepEqual(p.containment, [{ parent: 'srv', parentLabel: 'srvalto01', child: 'app', childLabel: 'ALTO' }]);
  };

  test('XML non compressé', () => check(parseDrawio(`<mxfile><diagram name="P1">${model}</diagram></mxfile>`)));
  test('XML compressé (base64 + deflate + URI)', () => {
    const payload = zlib.deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
    const res = parseDrawio(`<mxfile><diagram name="P1" id="x">${payload}</diagram></mxfile>`);
    assert.equal(res.pages[0].name, 'P1');
    check(res);
  });
});

describe('IP : règle stricte', () => {
  const cases = [
    ['Tel 01.23.45.82.17', []],
    ['01.23.45.82', []],
    ['srv sur 10.12.0.5.', ['10.12.0.5']],
    ['IP:192.168.1.10/24', ['192.168.1.10']],
    ['256.1.1.1', []],
    ['v1.10.0.1.2', []],
    ['(172.16.4.20)', ['172.16.4.20']],
    ['10.0.0.1, 10.0.0.2 et 10.0.0.1', ['10.0.0.1', '10.0.0.2']],
  ];
  for (const [text, expected] of cases) test(text, () => assert.deepEqual(extractIps(text), expected));
  test('téléphone : ni IP ni hôte', () => {
    const e = extractEntities('Phone 01.23.45.82.17 / 01.23.45.75.82');
    assert.deepEqual(e.ips, []);
    assert.deepEqual(e.hosts, []);
  });
  test("classifyToken : un morceau de téléphone n'est pas une IP", () => assert.equal(classifyToken('01.23.45.82'), 'unknown'));
});

describe('fichier d\'inventaire avec motif', () => {
  test('le plus récent selon la date dans le nom', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-inv-'));
    for (const f of ['apm_os_20261110.csv', 'apm_os_20260901.csv', 'autre.csv']) fs.writeFileSync(path.join(d, f), 'a');
    assert.equal(path.basename(resolveInputFile(d, './apm_os_*.csv')), 'apm_os_20261110.csv');
    assert.equal(resolveInputFile(d, './rien_*.csv'), null);
    assert.equal(path.basename(resolveInputFile(d, 'autre.csv')), 'autre.csv');
    assert.equal(resolveInputFile(d, 'absent.csv'), null);
  });
});
