'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLlmClient } = require('../src/lib/llmClient');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { ask } = require('../src/assistant/ask');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const baseCfg = { baseUrl: 'http://fake', token: 't', models: { extract: 'm-extract', chat: 'm-chat' }, timeoutMs: 1000, maxRetries: 2, concurrency: 2, cacheDir: null, jsonMode: true };
const reply = (content, extra = {}) => ({ choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

/** fetch simulé : chaque appel consomme la réponse suivante. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}

describe('llmClient', () => {
  test('retry sur 500 puis succès, modèle choisi par tâche', async () => {
    const f = fakeFetch([{ status: 500, body: 'oops' }, { status: 200, body: reply('salut') }]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent, backoffBaseMs: 1 });
    const r = await llm.chat({ task: 'extract', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content, 'salut');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.model, 'm-extract');
    assert.equal(llm.stats.retries, 1);
  });

  test('pas de retry sur 401, erreur remontée (plus de null silencieux)', async () => {
    const f = fakeFetch([{ status: 401, body: 'no' }]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent, backoffBaseMs: 1 });
    await assert.rejects(() => llm.chat({ messages: [] }), /HTTP 401/);
    assert.equal(f.calls.length, 1);
  });

  test('erreur réseau : retry puis échec après maxRetries', async () => {
    const f = fakeFetch([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent, backoffBaseMs: 1 });
    await assert.rejects(() => llm.chat({ messages: [] }), /réseau/);
    assert.equal(f.calls.length, 3);
  });

  test('reasoning_effort refusé -> désactivé et relancé sans, puis response_format refusé à son tour', async () => {
    const f = fakeFetch([
      { status: 400, body: '{"error":{"message":"Unsupported parameter: reasoning_effort"}}' },
      { status: 400, body: 'unsupported response_format' },
      { status: 200, body: reply('{"a":1}') },
      { status: 200, body: reply('{"a":2}') },
    ]);
    const llm = createLlmClient({ ...baseCfg, reasoningEffort: 'none' }, { fetch: f, logger: silent });
    assert.equal(llm.reasoningRefused, false);
    assert.deepEqual(await llm.chatJson({ messages: [] }), { a: 1 });
    assert.equal(f.calls[0].body.reasoning_effort, 'none');
    assert.deepEqual([f.calls[1].body.reasoning_effort, f.calls[2].body.reasoning_effort, f.calls[2].body.response_format], [undefined, undefined, undefined]);
    await llm.chatJson({ messages: [{ role: 'user', content: 'autre' }] });
    assert.deepEqual([f.calls[3].body.reasoning_effort, f.calls[3].body.response_format], [undefined, undefined]);
    assert.equal(llm.reasoningRefused, true);
  });

  test('une autre erreur 400 ne retire aucun réglage', async () => {
    const f = fakeFetch([{ status: 400, body: 'context length exceeded' }]);
    const llm = createLlmClient({ ...baseCfg, reasoningEffort: 'none' }, { fetch: f, logger: silent });
    await assert.rejects(() => llm.chat({ messages: [] }), /HTTP 400/);
    assert.equal(f.calls.length, 1);
  });

  test('response_format refusé -> désactivé et relancé sans', async () => {
    const f = fakeFetch([{ status: 400, body: 'unsupported response_format' }, { status: 200, body: reply('{"a":1}') }, { status: 200, body: reply('{"a":2}') }]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    assert.deepEqual(await llm.chatJson({ messages: [] }), { a: 1 });
    assert.equal(f.calls[1].body.response_format, undefined);
    await llm.chatJson({ messages: [{ role: 'user', content: 'autre' }] });
    assert.equal(f.calls[2].body.response_format, undefined);
  });

  test('chatJson répare une réponse invalide en un essai', async () => {
    const f = fakeFetch([{ status: 200, body: reply('désolé pas de json') }, { status: 200, body: reply('{"entities":[],"relations":[]}') }]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    const r = await llm.chatJson({ messages: [{ role: 'user', content: 'x' }], schema: { entities: 'array', relations: 'array' } });
    assert.deepEqual(r, { entities: [], relations: [] });
    assert.match(f.calls[1].body.messages.at(-1).content, /pas exploitable/);
  });

  test('sends reasoning_effort when configured', async () => {
    const f = fakeFetch([{ status: 200, body: reply('ok') }]);
    const llm = createLlmClient({ ...baseCfg, reasoningEffort: 'none' }, { fetch: f, logger: silent });
    await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(f.calls[0].body.reasoning_effort, 'none');
  });

  test('does not send reasoning_effort by default', async () => {
    const f = fakeFetch([{ status: 200, body: reply('ok') }]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal('reasoning_effort' in f.calls[0].body, false);
  });

  test('empty answer is not cached and is retried with doubled max_tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const f = fakeFetch([{ status: 200, body: reply('') }, { status: 200, body: reply('bonjour') }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    const r = await llm.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
    assert.equal(r.content, 'bonjour');
    assert.deepEqual(f.calls.map((c) => c.body.max_tokens), [100, 200]);
    // le cache de la requête d'origine ne contient que la bonne réponse
    const f2 = fakeFetch([]);
    const again = await createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f2, logger: silent }).chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
    assert.equal(again.content, 'bonjour');
    assert.equal(f2.calls.length, 0);
  });

  test('empty answer after retry throws empty and caches nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const f = fakeFetch([{ status: 200, body: reply('') }, { status: 200, body: reply('  ') }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    await assert.rejects(() => llm.chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'empty');
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  test('length-truncated answer throws truncated after one retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const cut = { choices: [{ message: { content: 'début de répon' }, finish_reason: 'length' }] };
    const f = fakeFetch([{ status: 200, body: cut }, { status: 200, body: cut }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    await assert.rejects(() => llm.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50 }), (e) => e.code === 'truncated');
    assert.deepEqual(f.calls.map((c) => c.body.max_tokens), [50, 100]);
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  test('valid answer is cached as before', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const ok = { choices: [{ message: { content: 'fini' }, finish_reason: 'stop' }] };
    const f = fakeFetch([{ status: 200, body: ok }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal((await llm.chat({ messages: [{ role: 'user', content: 'x' }] })).cached, true);
    assert.equal(f.calls.length, 1);
  });

  test('invalid JSON after repair throws invalid_json and caches nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const f = fakeFetch([{ status: 200, body: reply('pas du json') }, { status: 200, body: reply('toujours pas') }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    await assert.rejects(() => llm.chatJson({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'invalid_json');
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  test('final empty/truncated/invalid_json errors are counted once, recovered retries are not', async () => {
    const cut = { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] };
    let llm = createLlmClient(baseCfg, { fetch: fakeFetch([{ status: 200, body: cut }, { status: 200, body: cut }]), logger: silent });
    await assert.rejects(() => llm.chat({ messages: [{ role: 'user', content: 'a' }] }));
    assert.equal(llm.stats.errors, 1);
    llm = createLlmClient(baseCfg, { fetch: fakeFetch([{ status: 200, body: reply('') }, { status: 200, body: reply('ok') }]), logger: silent });
    await llm.chat({ messages: [{ role: 'user', content: 'a' }] });
    assert.equal(llm.stats.errors, 0);
    llm = createLlmClient(baseCfg, { fetch: fakeFetch([{ status: 200, body: reply('nope') }, { status: 200, body: reply('nope') }]), logger: silent });
    await assert.rejects(() => llm.chatJson({ messages: [{ role: 'user', content: 'a' }] }));
    assert.equal(llm.stats.errors, 1);
  });

  test('empty content with tool_calls is accepted and cached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const tc = [{ id: '1', type: 'function', function: { name: 'ping', arguments: '{}' } }];
    const f = fakeFetch([{ status: 200, body: reply('', { tool_calls: tc }) }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    const msg = { messages: [{ role: 'user', content: 'x' }], cache: true };
    const r = await llm.chat(msg);
    assert.equal(r.toolCalls.length, 1);
    assert.equal((await llm.chat(msg)).cached, true);
    assert.equal(f.calls.length, 1);
  });

  test('cache disque : deuxième appel identique sans réseau', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const f = fakeFetch([{ status: 200, body: reply('A') }]);
    const llm = createLlmClient({ ...baseCfg, cacheDir: dir }, { fetch: f, logger: silent });
    const msg = { messages: [{ role: 'user', content: 'même question' }] };
    await llm.chat(msg);
    const second = await llm.chat(msg);
    assert.equal(second.content, 'A');
    assert.equal(second.cached, true);
    assert.equal(f.calls.length, 1);
  });

  test('concurrence limitée', async () => {
    let active = 0;
    let max = 0;
    const f = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { ok: true, status: 200, text: async () => JSON.stringify(reply('ok')) };
    };
    const llm = createLlmClient({ ...baseCfg, concurrency: 2 }, { fetch: f, logger: silent });
    await Promise.all(Array.from({ length: 6 }, (_, i) => llm.chat({ messages: [{ role: 'user', content: String(i) }] })));
    assert.equal(max, 2);
  });
});

describe('assistant ask (outils)', () => {
  test('le modèle appelle les outils puis répond', async () => {
    const repo = createRepo(openStore(':memory:'));
    const srv = repo.upsertNode({ type: 'server', key: 'srv01', source: 't' });
    const app = repo.upsertNode({ type: 'application', key: 'ALTO', name: 'ALTO', source: 't' });
    repo.addEdge({ src: app, dst: srv, type: 'runs_on', source: 't' });

    const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const f = fakeFetch([
      { status: 200, body: reply('', { tool_calls: [toolCall('1', 'search_entities', { query: 'srv01' })] }) },
      { status: 200, body: reply('', { tool_calls: [toolCall('2', 'impact_analysis', { id: 'server:srv01' })] }) },
      { status: 200, body: reply("Si srv01 tombe, ALTO est impactée.") },
    ]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    const r = await ask({ llm, repo, question: 'Que se passe-t-il si srv01 tombe ?' });
    assert.match(r.answer, /ALTO/);
    assert.deepEqual(r.toolTrace.map((t) => t.tool), ['search_entities', 'impact_analysis']);
    const toolMsg = f.calls[2].body.messages.at(-1);
    assert.equal(toolMsg.role, 'tool');
    assert.match(toolMsg.content, /application:alto/);
    assert.equal(f.calls[0].body.model, 'm-chat');
  });
});

describe('assistant ask sans function calling (LLM_TOOLS_MODE=json)', () => {
  const setup = () => {
    const repo = createRepo(openStore(':memory:'));
    const srv = repo.upsertNode({ type: 'server', key: 'srv01', source: 't' });
    const app = repo.upsertNode({ type: 'application', key: 'ALTO', name: 'ALTO', source: 't' });
    repo.addEdge({ src: app, dst: srv, type: 'runs_on', source: 't' });
    return repo;
  };
  test('mode json : outil demandé en JSON, résultat renvoyé, puis réponse', async () => {
    const repo = setup();
    const f = fakeFetch([
      { status: 200, body: reply('{"tool": "impact_analysis", "arguments": {"id": "server:srv01"}}') },
      { status: 200, body: reply('{"answer": "ALTO est impactée."}') },
    ]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    const r = await ask({ llm, repo, question: 'srv01 tombe ?', toolsMode: 'json' });
    assert.equal(r.answer, 'ALTO est impactée.');
    assert.equal(r.toolsMode, 'json');
    assert.deepEqual(r.toolTrace.map((t) => t.tool), ['impact_analysis']);
    assert.equal(f.calls[0].body.tools, undefined);
    assert.match(f.calls[1].body.messages.at(-1).content, /application:alto/);
  });
  test('mode native refusé par la passerelle (400) : bascule automatique en json', async () => {
    const repo = setup();
    const f = fakeFetch([
      { status: 400, body: '{"error":"tools are not supported"}' },
      { status: 200, body: reply('{"answer": "OK"}') },
    ]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    const r = await ask({ llm, repo, question: 'x' });
    assert.equal(r.answer, 'OK');
    assert.equal(r.toolsMode, 'json');
    assert.ok(f.calls[0].body.tools);
    assert.equal(f.calls[1].body.tools, undefined);
  });
});

describe('langue du chat', () => {
  const { systemFor } = require('../src/assistant/ask');
  test('français par défaut, anglais sur demande', () => {
    assert.match(systemFor('fr'), /Tu réponds en français/);
    assert.match(systemFor('en'), /Answer in English/);
    assert.doesNotMatch(systemFor('en'), /Tu réponds en français/);
  });
});
