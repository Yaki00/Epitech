'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher } = require('../src/perimeter/perimeter');
const { fetchThruk } = require('../src/naemon/thruk');
const { readNaemonCsv } = require('../src/naemon/csvSource');
const { createPoller, readUnmatchedHosts } = require('../src/naemon/poller');
const { createFetchRaw } = require('../src/naemon/source');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-naemon-'));
const reply = (status, body, ok = status >= 200 && status < 300) => ({ ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

const THRUK_HOSTS = [
  { name: 'srvalto01', address: '10.0.0.1', state: 1, plugin_output: 'CRITICAL - down', last_check: 1700000000, groups: ['alto', 'linux'], acknowledged: 1, scheduled_downtime_depth: 0 },
  { name: 'srvalto02', address: '10.0.0.2', state: 0, plugin_output: 'OK', last_check: 1700000100, groups: [], acknowledged: 0, scheduled_downtime_depth: 2 },
];
const THRUK_SERVICES = [{ host_name: 'srvalto02', description: 'disk /', state: 1, plugin_output: 'WARN 85 %', last_check: 1700000200, acknowledged: 0, scheduled_downtime_depth: 0 }];

describe('fetchThruk', () => {
  const cfg = { thrukUrl: 'https://naemon.example.local/thruk/', token: '', user: '', password: '' };
  const fakeHttp = (calls, answer = (url) => reply(200, url.includes('/r/hosts') ? THRUK_HOSTS : THRUK_SERVICES)) => async (url, opt) => {
    calls.push({ url, headers: (opt && opt.headers) || {} });
    return answer(url);
  };

  test('JSON de Thruk normalisé vers le relevé attendu par le calcul des états', async () => {
    const calls = [];
    const raw = await fetchThruk(cfg, { http: fakeHttp(calls), now: () => Date.parse('2026-11-23T10:00:00Z') });
    assert.equal(calls[0].url, 'https://naemon.example.local/thruk/r/hosts?columns=name,address,state,plugin_output,last_check,groups,acknowledged,scheduled_downtime_depth');
    assert.equal(calls[1].url, 'https://naemon.example.local/thruk/r/services?columns=host_name,description,state,plugin_output,last_check,acknowledged,scheduled_downtime_depth');
    assert.equal(raw.fetchedAt, '2026-11-23T10:00:00.000Z');
    assert.deepEqual(raw.hosts[0], { name: 'srvalto01', address: '10.0.0.1', state: 1, output: 'CRITICAL - down', lastCheck: 1700000000, groups: ['alto', 'linux'], ack: true, downtime: false });
    assert.equal(raw.hosts[1].downtime, true);
    assert.equal(raw.hosts[1].ack, false);
    assert.deepEqual(raw.services[0], { host: 'srvalto02', description: 'disk /', state: 1, output: 'WARN 85 %', lastCheck: 1700000200, ack: false, downtime: false });
  });

  test('jeton : en-tête X-Thruk-Auth-Key', async () => {
    const calls = [];
    await fetchThruk({ ...cfg, token: 'abc123' }, { http: fakeHttp(calls) });
    for (const c of calls) {
      assert.equal(c.headers['X-Thruk-Auth-Key'], 'abc123');
      assert.equal(c.headers.Authorization, undefined);
    }
  });

  test('sans jeton : Basic avec utilisateur et mot de passe', async () => {
    const calls = [];
    await fetchThruk({ ...cfg, user: 'lyra', password: 'secret' }, { http: fakeHttp(calls) });
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('lyra:secret').toString('base64')}`);
    assert.equal(calls[0].headers['X-Thruk-Auth-Key'], undefined);
  });

  test('page HTML reçue : erreur claire', async () => {
    await assert.rejects(fetchThruk(cfg, { http: fakeHttp([], () => reply(200, '<html><body>Login</body></html>')) }), /page HTML reçue \(connexion \?\)/);
  });

  test('401 : erreur avec le code', async () => {
    await assert.rejects(fetchThruk(cfg, { http: fakeHttp([], () => reply(401, 'Unauthorized')) }), /401/);
  });

  test('URL absente : erreur claire', async () => {
    await assert.rejects(fetchThruk({ ...cfg, thrukUrl: '' }, { http: fakeHttp([]) }), /NAEMON_THRUK_URL/);
  });

  test('réponse JSON qui n est pas une liste : erreur', async () => {
    await assert.rejects(fetchThruk(cfg, { http: fakeHttp([], () => reply(200, { message: 'nope' })) }), /liste/);
  });
});

describe('readNaemonCsv', () => {
  test('colonnes par lettres, états texte, une ligne par hôte', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'hosts.csv'), 'Hôte;Adresse;Statut;Sortie;Dernier contrôle;Groupes;Acquitté;Maintenance\nsrvalto01;10.0.0.1;DOWN;panne;1700000000;alto, linux;oui;0\nsrvalto02;10.0.0.2;UP;ok;1700000100;;non;1\nsrvalto03;;UNREACHABLE;;;;;\n');
    const raw = readNaemonCsv(dir, { file: './hosts.csv', kind: 'hosts', columns: { name: 'A', address: 'B', state: 'C', output: 'D', lastCheck: 'E', groups: 'F', ack: 'G', downtime: 'H' } });
    assert.deepEqual(raw.services, []);
    assert.deepEqual(raw.hosts.map((h) => h.state), [1, 0, 2]);
    assert.deepEqual(raw.hosts[0], { name: 'srvalto01', address: '10.0.0.1', state: 1, output: 'panne', lastCheck: 1700000000, groups: ['alto', 'linux'], ack: true, downtime: false });
    assert.equal(raw.hosts[1].downtime, true);
    assert.equal(raw.hosts[2].lastCheck, null);
    assert.ok(raw.fetchedAt);
  });

  test('services : états texte et en-têtes de colonnes', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'services.csv'), 'host_name,description,state,plugin_output\nsrvalto01,cpu,WARNING,haut\nsrvalto01,disk,CRITICAL,plein\nsrvalto01,ping,OK,\nsrvalto01,mem,UNKNOWN,?\n');
    const raw = readNaemonCsv(dir, { file: './services.csv', kind: 'services', columns: { host: 'host_name', description: 'description', state: 'state', output: 'plugin_output' } });
    assert.deepEqual(raw.hosts, []);
    assert.deepEqual(raw.services.map((s) => s.state), [1, 2, 0, 3]);
    assert.equal(raw.services[0].host, 'srvalto01');
    assert.equal(raw.services[1].output, 'plein');
  });

  test('motif * : fichier le plus récent ; fichier absent ou colonne absente : erreur claire', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'h_20261101.csv'), 'n;s\nold;DOWN\n');
    fs.writeFileSync(path.join(dir, 'h_20261110.csv'), 'n;s\nnew;UP\n');
    const raw = readNaemonCsv(dir, { file: './h_*.csv', kind: 'hosts', columns: { name: 'n', state: 's' } });
    assert.deepEqual(raw.hosts.map((h) => h.name), ['new']);
    assert.throws(() => readNaemonCsv(dir, { file: './rien_*.csv', kind: 'hosts', columns: { name: 'n', state: 's' } }), /aucun fichier/);
    assert.throws(() => readNaemonCsv(dir, { file: './h_*.csv', kind: 'hosts', columns: { name: 'Z9', state: 's' } }), /colonne/);
  });
});

describe('createFetchRaw', () => {
  test('csv : fichier NAEMON_CSV_FILE prioritaire sur le fichier du mapping', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'x.csv'), 'n;s\nsrv1;UP\n');
    const fetchRaw = createFetchRaw({ naemon: { source: 'csv', csvFile: './x.csv' }, root: dir, inventory: { mappingFile: path.join(dir, 'mappings.json') } }, { mapping: { naemon: { file: './autre.csv', kind: 'hosts', columns: { name: 'n', state: 's' } } } });
    const raw = await fetchRaw();
    assert.equal(raw.hosts[0].name, 'srv1');
  });
  test('source off : erreur explicite', () => {
    assert.throws(() => createFetchRaw({ naemon: { source: 'off' } }), /off/);
  });
});

describe('poller', () => {
  let repo;
  let matcher;
  beforeEach(() => {
    repo = createRepo(openStore(':memory:'));
    repo.upsertNode({ type: 'application', key: 'alto', name: 'alto', attrs: { perimeter: true }, source: 't' });
    const id = repo.upsertNode({ type: 'server', key: 'srvalto01', name: 'srvalto01', attrs: { environment: 'PRD' }, source: 't' });
    repo.addEdge({ src: 'application:alto', dst: id, type: 'runs_on', source: 't' });
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ applications: [{ name: 'alto' }] }));
    matcher = createMatcher(loadPerimeter(path.join(dir, 'p.json')), repo);
  });
  const rawDown = { fetchedAt: '2026-11-23T10:00:00Z', hosts: [{ name: 'srvalto01', address: '', state: 1, output: 'x', lastCheck: 1, groups: [], ack: false, downtime: false }], services: [] };
  const base = () => ({ cfg: { source: 'thruk', pollMinutes: 5 }, repo, matcher, file: path.join(tmp(), 'naemon-status.json') });

  test('relève réussie : état calculé, persisté, lastOk et nextAt', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z');
    const p = createPoller({ ...base(), fetchRaw: async () => rawDown, now: () => t });
    assert.equal(p.snapshot().status, null);
    await p.refresh();
    const s = p.snapshot();
    assert.equal(s.status.servers['server:srvalto01'].state, 'down');
    assert.equal(s.source, 'thruk');
    assert.equal(s.lastOk, '2026-11-23T10:00:00.000Z');
    assert.equal(s.lastError, null);
    assert.equal(s.nextAt, null);
  });

  test('erreur : l ancien état est gardé et lastError exposé', async () => {
    let fail = false;
    const p = createPoller({ ...base(), fetchRaw: async () => { if (fail) throw new Error('page HTML reçue (connexion ?)'); return rawDown; }, now: () => 1000 });
    await p.refresh();
    const before = p.snapshot().status;
    fail = true;
    await p.refresh();
    const s = p.snapshot();
    assert.deepEqual(s.status, before);
    assert.equal(s.lastError, 'page HTML reçue (connexion ?)');
    assert.ok(s.lastOk);
    fail = false;
    await p.refresh();
    assert.equal(p.snapshot().lastError, null);
  });

  test('relecture du fichier au démarrage, puis une erreur garde cet état', async () => {
    const b = base();
    const p1 = createPoller({ ...b, fetchRaw: async () => rawDown, now: () => Date.parse('2026-11-23T10:00:00Z') });
    await p1.refresh();
    const p2 = createPoller({ ...b, fetchRaw: async () => { throw new Error('injoignable'); }, now: () => Date.parse('2026-11-23T11:00:00Z') });
    assert.equal(p2.snapshot().status.servers['server:srvalto01'].state, 'down');
    assert.equal(p2.snapshot().lastOk, '2026-11-23T10:00:00.000Z');
    await p2.refresh();
    assert.equal(p2.snapshot().status.servers['server:srvalto01'].state, 'down');
    assert.equal(p2.snapshot().lastError, 'injoignable');
  });

  test('fichier corrompu au démarrage : ignoré', () => {
    const b = base();
    fs.writeFileSync(b.file, '{pas du json');
    const p = createPoller({ ...b, fetchRaw: async () => rawDown });
    assert.equal(p.snapshot().status, null);
  });

  test('start/stop : intervalle injecté, relève immédiate, nextAt', async () => {
    const calls = [];
    const cleared = [];
    let n = 0;
    const p = createPoller({ ...base(), fetchRaw: async () => { n++; return rawDown; }, now: () => 5000, setIntervalFn: (fn, ms) => { calls.push({ fn, ms }); return 42; }, clearIntervalFn: (h) => cleared.push(h) });
    await p.start();
    assert.equal(n, 1);
    assert.equal(calls[0].ms, 5 * 60000);
    assert.equal(p.snapshot().nextAt, new Date(5000 + 5 * 60000).toISOString());
    await calls[0].fn();
    assert.equal(n, 2);
    p.stop();
    assert.deepEqual(cleared, [42]);
    assert.equal(p.snapshot().nextAt, null);
  });

  test('perimeter.json : naemonHostgroups lu et exposé sur les applications du matcher', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ applications: [{ name: 'alto', naemonHostgroups: ['hg-alto-prd', ' hg-alto-stg '] }, { name: 'brief' }] }));
    const m = createMatcher(loadPerimeter(path.join(dir, 'p.json')), repo);
    assert.deepEqual(m.apps.find((a) => a.name === 'alto').naemonHostgroups, ['hg-alto-prd', 'hg-alto-stg']);
    assert.deepEqual(m.apps.find((a) => a.name === 'brief').naemonHostgroups, []);
  });

  test('hash du périmètre identique à la v1 : naemonHostgroups n y entre pas', () => {
    const { sha256 } = require('../src/lib/hash');
    const dir = tmp();
    const write = (apps) => {
      fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ applications: apps }));
      return loadPerimeter(path.join(dir, 'p.json')).hash;
    };
    const v1 = sha256(JSON.stringify([[{ name: 'alto', aliases: ['AL'], auid: null }], null])).slice(0, 12);
    assert.equal(write([{ name: 'alto', aliases: ['AL'] }]), v1);
    assert.equal(write([{ name: 'alto', aliases: ['AL'], naemonHostgroups: ['hg1'] }]), v1);
  });
});

describe('readUnmatchedHosts (hôtes Naemon hors inventaire donnés à la lecture des pages)', () => {
  test('read from the file written by the poller ({ source, lastOk, status }), lower case', () => {
    const file = path.join(tmp(), 'naemon-status.json');
    fs.writeFileSync(file, JSON.stringify({ source: 'thruk', lastOk: '2026-11-23T10:00:00Z', status: { servers: {}, unmatchedHosts: ['SRVORA01', 'srvx02'] } }));
    assert.deepEqual(readUnmatchedHosts(file), ['srvora01', 'srvx02']);
  });

  test('missing or unreadable file gives an empty list ; a bare status is still read', () => {
    const dir = tmp();
    assert.deepEqual(readUnmatchedHosts(path.join(dir, 'absent.json')), []);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.deepEqual(readUnmatchedHosts(path.join(dir, 'bad.json')), []);
    fs.writeFileSync(path.join(dir, 'bare.json'), JSON.stringify({ unmatchedHosts: ['srvy03'] }));
    assert.deepEqual(readUnmatchedHosts(path.join(dir, 'bare.json')), ['srvy03']);
  });
});
