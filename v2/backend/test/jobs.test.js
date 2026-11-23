'use strict';
const assert = require('assert').strict;
const { EventEmitter } = require('events');
const request = require('supertest');

const { createJobRunner, jobDefinitions } = require('../src/api/jobs');
const { createApp } = require('../src/api/app');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');

/** Faux processus : écrit des lignes puis se termine avec le code donné (par script). */
function fakeSpawn(codes) {
  const calls = [];
  const fn = (exe, [script, ...args]) => {
    const name = script.split(/[\\/]/).pop();
    calls.push([name, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(`début ${name}\nfin `));
      child.stdout.emit('data', Buffer.from(`${name}\n`));
      child.emit('close', codes[name] ?? 0);
    });
    return child;
  };
  return { fn, calls };
}
const waitDone = async (runner) => {
  for (let i = 0; i < 50 && runner.status().current.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return runner.status().current;
};

describe('synchros lancées depuis l\'interface', () => {
  test('tâches proposées ; Confluence ne récupère les pages que si CONFLUENCE_BASE_URL est rempli', () => {
    assert.deepEqual(Object.keys(jobDefinitions({})), ['confluence', 'apm', 'marketplace', 'all']);
    assert.equal(jobDefinitions({}).confluence.steps[0][0], 'sync-confluence.js');
    assert.equal(jobDefinitions({ CONFLUENCE_BASE_URL: 'https://x' }).confluence.steps[0][0], 'fetch-confluence.js');
  });

  test('étapes enchaînées, journal ligne par ligne, une seule tâche à la fois', async () => {
    const { fn, calls } = fakeSpawn({});
    const runner = createJobRunner({ scriptsDir: '/s', cwd: '/c', spawnFn: fn, env: {} });
    assert.equal(runner.start('marketplace').current.status, 'running');
    assert.throws(() => runner.start('apm'), (err) => err.status === 409);
    const cur = await waitDone(runner);
    assert.equal(cur.status, 'success');
    assert.deepEqual(calls, ['fetch-inventory.js marketplace', 'sync-inventory.js marketplace']);
    assert.ok(cur.lines.includes('fin fetch-inventory.js')); // ligne coupée entre deux morceaux recollée
    assert.throws(() => runner.start('inconnue'), (err) => err.status === 400);
  });

  test('une étape en échec : les suivantes tournent, la tâche finit en erreur', async () => {
    const { fn, calls } = fakeSpawn({ 'sync-confluence.js': 1 });
    const runner = createJobRunner({ scriptsDir: '/s', cwd: '/c', spawnFn: fn, env: {} });
    runner.start('confluence');
    const cur = await waitDone(runner);
    assert.equal(cur.status, 'error');
    assert.deepEqual(calls, ['sync-confluence.js --llm', 'summarize-apps.js']);
    assert.deepEqual(cur.steps.map((s) => s.status), ['error', 'success']);
  });

  test('API : désactivée sans lanceur, active avec', async () => {
    const repo = createRepo(openStore(':memory:'));
    const off = createApp({ repo, llm: null });
    assert.deepEqual((await request(off).get('/api/sync/jobs')).body, { enabled: false, jobs: [], current: null });
    assert.equal((await request(off).post('/api/sync/jobs').send({ job: 'all' })).status, 403);

    // processus qui ne se termine pas pendant le test : la 2e demande arrive pendant la 1re tâche
    const hanging = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const on = createApp({ repo, llm: null, jobs: createJobRunner({ scriptsDir: '/s', cwd: '/c', spawnFn: hanging, env: {} }) });
    const res = await request(on).post('/api/sync/jobs').send({ job: 'apm' });
    assert.equal(res.status, 202);
    assert.equal(res.body.current.label, 'APM');
    assert.equal((await request(on).post('/api/sync/jobs').send({ job: 'all' })).status, 409);
  });
});
