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

  const floorCfg = { ...baseCfg, maxTokens: { reasoning: 8192 } };
  const msg = [{ role: 'user', content: 'x' }];

  test('reasoning off: small requests get the reasoning floor', async () => {
    const f = fakeFetch([{ status: 200, body: reply('a') }, { status: 200, body: reply('b') }]);
    const llm = createLlmClient(floorCfg, { fetch: f, logger: silent });
    await llm.chat({ messages: msg, maxTokens: 1600 });
    await llm.chat({ messages: msg, maxTokens: 20000, temperature: 0.5 });
    assert.equal(f.calls[0].body.max_tokens, 8192);
    assert.equal(f.calls[1].body.max_tokens, 20000);
  });

  test('reasoning refused: floor applies after the refusal', async () => {
    const f = fakeFetch([
      { status: 400, body: '{"error":{"message":"Unsupported parameter: reasoning_effort"}}' },
      { status: 200, body: reply('a') },
      { status: 200, body: reply('b') },
    ]);
    const llm = createLlmClient({ ...floorCfg, reasoningEffort: 'none' }, { fetch: f, logger: silent });
    await llm.chat({ messages: msg, maxTokens: 1600 });
    assert.equal(f.calls[0].body.max_tokens, 1600);
    assert.equal(f.calls[1].body.max_tokens, 8192);
    await llm.chat({ messages: [{ role: 'user', content: 'y' }], maxTokens: 1500 });
    assert.equal(f.calls[2].body.max_tokens, 8192);
  });

  test('reasoning accepted: requested max_tokens sent unchanged', async () => {
    const f = fakeFetch([{ status: 200, body: reply('a') }]);
    const llm = createLlmClient({ ...floorCfg, reasoningEffort: 'none' }, { fetch: f, logger: silent });
    await llm.chat({ messages: msg, maxTokens: 1600 });
    assert.equal(f.calls[0].body.max_tokens, 1600);
    assert.equal(f.calls[0].body.reasoning_effort, 'none');
  });

  test('retry doubles the floor', async () => {
    const f = fakeFetch([
      { status: 200, body: { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] } },
      { status: 200, body: reply('ok') },
    ]);
    const llm = createLlmClient(floorCfg, { fetch: f, logger: silent });
    const r = await llm.chat({ messages: msg, maxTokens: 1600 });
    assert.equal(r.content, 'ok');
    assert.deepEqual(f.calls.map((c) => c.body.max_tokens), [8192, 16384]);
  });

  test('cache key ignores the floor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-cache-'));
    const f1 = fakeFetch([{ status: 200, body: reply('cached') }]);
    await createLlmClient({ ...floorCfg, cacheDir: dir }, { fetch: f1, logger: silent }).chat({ messages: msg, maxTokens: 1600 });
    const f2 = fakeFetch([]);
    const r = await createLlmClient({ ...floorCfg, maxTokens: { reasoning: 4096 }, cacheDir: dir }, { fetch: f2, logger: silent }).chat({ messages: msg, maxTokens: 1600 });
    assert.equal(r.cached, true);
    assert.equal(f2.calls.length, 0);
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

  test('rerank : scores dans l ordre des documents, chemin et modele de la config', async () => {
    const f = fakeFetch([{ status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.5 }] } }]);
    const llm = createLlmClient({ ...baseCfg, models: { rerank: 'm-rerank' } }, { fetch: f, logger: silent, backoffBaseMs: 1 });
    const scores = await llm.rerank({ query: 'q', documents: ['a', 'b', 'c'], path: '/v1/rerank' });
    assert.deepEqual(scores, [0.2, 0.9, 0.5]);
    assert.equal(f.calls[0].url, 'http://fake/v1/rerank');
    assert.deepEqual(f.calls[0].body, { model: 'm-rerank', query: 'q', documents: ['a', 'b', 'c'] });
  });

  test('rerank : reponse incomplete = erreur', async () => {
    const f = fakeFetch([{ status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } }]);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent, backoffBaseMs: 1 });
    await assert.rejects(() => llm.rerank({ query: 'q', documents: ['a', 'b'] }), /rerank/i);
  });
});

describe('assistant ask (documentation)', () => {
  const { createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
  const { applyFiches } = require('../src/knowledge/apply');
  const { buildKnowledgeIndex } = require('../src/knowledge/search');
  const item = (text) => ({ text, evidence: text });
  const PERIMETER = { applications: [{ name: 'OrderHub', aliases: [], auid: null }], ignoreOtherApplications: true };
  const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

  function world({ withFiche = true, url = 'https://wiki.example.local/7001' } = {}) {
    const repo = createRepo(openStore(':memory:'));
    ensurePerimeterNodes(repo, PERIMETER);
    let ficheId = null;
    if (withFiche) {
      const doc = repo.upsertNode({ type: 'document', key: 'confluence-7001', name: 'Page 7001', source: 'confluence' });
      const f = { kind: 'incident', title: item('File pleine'), section: null, date: null, fields: { symptoms: item('la file Q.MRL.EVT est saturee') }, lists: {}, appIds: ['application:orderhub'], serverIds: [], unresolved: [], tickets: [], keywords: [], replaces: null, fixes: null };
      ficheId = applyFiches(repo, { fiches: [f], rejected: [] }, { pageId: '7001', docNodeId: doc, page: { title: 'Page 7001', url, updatedAt: '2026-10-01T10:00:00.000Z' }, period: 'current' }).fiches[0];
    }
    const knowledge = { index: buildKnowledgeIndex(repo, { sections: [] }), matcher: createMatcher(PERIMETER, repo) };
    return { repo, knowledge, ficheId };
  }
  const run = async (w, responses, extra = {}) => {
    const f = fakeFetch(responses);
    const llm = createLlmClient(baseCfg, { fetch: f, logger: silent });
    const r = await ask({ llm, repo: w.repo, question: 'la file Q.MRL.EVT est saturee', knowledge: w.knowledge, ...extra });
    return { r, f };
  };
  const calls = (w) => [
    { status: 200, body: reply('', { tool_calls: [toolCall('1', 'search_knowledge', { query: 'file Q.MRL.EVT saturee' })] }) },
    { status: 200, body: reply('', { tool_calls: [toolCall('2', 'open_fiche', { id: w.ficheId })] }) },
  ];

  test('troubleshooting question calls search then open', async () => {
    const w = world();
    const { r, f } = await run(w, [...calls(w), { status: 200, body: reply('Voir File pleine https://wiki.example.local/7001') }]);
    assert.deepEqual(r.toolTrace.map((t) => t.tool), ['search_knowledge', 'open_fiche']);
    assert.match(f.calls[1].body.messages.at(-1).content, /File pleine/);
    assert.match(f.calls[2].body.messages.at(-1).content, /wiki\.example\.local\/7001/);
    assert.match(f.calls[0].body.messages[0].content, /rien trouvé dans la documentation/);
    assert.ok(f.calls[0].body.tools.some((t) => t.function.name === 'search_knowledge'));
  });

  test('answer keeps only links from tool results', async () => {
    const w = world();
    const text = 'Voir [la fiche](https://wiki.example.local/7001) et [un autre](https://evil.example.com/x) puis https://invented.example.com/y fin';
    const { r } = await run(w, [...calls(w), { status: 200, body: reply(text) }]);
    assert.ok(r.answer.includes('https://wiki.example.local/7001'));
    assert.ok(r.answer.includes('un autre'));
    assert.ok(!r.answer.includes('evil.example.com'));
    assert.ok(!r.answer.includes('invented.example.com'));
    assert.deepEqual(r.removedLinks, ['https://evil.example.com/x', 'https://invented.example.com/y']);
  });

  test('trailing slash and anchor do not count as different links', async () => {
    const w = world();
    const { r } = await run(w, [...calls(w), { status: 200, body: reply('A https://wiki.example.local/7001/ et B https://wiki.example.local/7001#etape-2 ok') }]);
    assert.deepEqual(r.removedLinks, []);
    assert.ok(r.answer.includes('7001#etape-2'));
  });

  test('sources list the opened fiches', async () => {
    const w = world();
    const { r } = await run(w, [...calls(w), { status: 200, body: reply('Voir https://wiki.example.local/7001') }]);
    assert.equal(r.sources.length, 1);
    assert.deepEqual(r.sources[0], { id: w.ficheId, kind: 'incident', title: 'File pleine', url: 'https://wiki.example.local/7001', updatedAt: '2026-10-01T10:00:00.000Z', appNames: ['OrderHub'], old: false, replaced: false, otherApplication: false });
  });

  test('nothing found says so', async () => {
    const w = world({ withFiche: false });
    const { r, f } = await run(w, [
      { status: 200, body: reply('', { tool_calls: [toolCall('1', 'search_knowledge', { query: 'file saturee' })] }) },
      { status: 200, body: reply('Rien trouvé dans la documentation. https://invented.example.com/z') },
    ]);
    assert.deepEqual(JSON.parse(f.calls[1].body.messages.at(-1).content), { fiches: [], sections: [], apps: [] });
    assert.deepEqual(r.sources, []);
    assert.ok(!/https?:/.test(r.answer));
    assert.deepEqual(r.removedLinks, ['https://invented.example.com/z']);
  });

  test('emphasis and guillemets around a link do not remove it', async () => {
    const w = world();
    const u = 'https://wiki.example.local/7001';
    const text = `**${u}** *${u}* _${u}_ ${u}» «${u}» <${u}> ([lien](${u}))`;
    const { r } = await run(w, [...calls(w), { status: 200, body: reply(text) }]);
    assert.deepEqual(r.removedLinks, []);
    assert.equal(r.answer, text);
  });

  test('markdown link with a disallowed label and angle brackets', async () => {
    const w = world();
    const u = 'https://wiki.example.local/7001';
    const text = `[https://evil.example.com/a](${u}) puis <https://evil.example.com/b> fin, [x](<https://evil.example.com/c>)`;
    const { r } = await run(w, [...calls(w), { status: 200, body: reply(text) }]);
    assert.equal(r.answer, `${u} puis fin, x`);
    assert.deepEqual(r.removedLinks, ['https://evil.example.com/a', 'https://evil.example.com/b', 'https://evil.example.com/c']);
  });

  test('scheme and host compare case-insensitively', async () => {
    const w = world();
    const { r } = await run(w, [...calls(w), { status: 200, body: reply('HTTPS://WIKI.EXAMPLE.LOCAL/7001 ok HTTPS://EVIL.EXAMPLE.COM/x') }]);
    assert.deepEqual(r.removedLinks, ['HTTPS://EVIL.EXAMPLE.COM/x']);
    assert.ok(!/EVIL/i.test(r.answer));
  });

  test('a failing search tool does not break the chat', async () => {
    const w = world();
    w.knowledge = { index: {}, matcher: null };
    const warns = [];
    const { r, f } = await run(
      w,
      [{ status: 200, body: reply('', { tool_calls: [toolCall('1', 'search_knowledge', { query: 'file' })] }) }, { status: 200, body: reply('Rien trouvé dans la documentation.') }],
      { logger: { warn: (m, c) => warns.push([m, c]) } },
    );
    assert.deepEqual(JSON.parse(f.calls[1].body.messages.at(-1).content), { error: 'recherche indisponible' });
    assert.match(r.answer, /Rien trouvé/);
    assert.equal(warns.length, 1);
  });

  test('json mode: search then answer with an allowed link', async () => {
    const w = world();
    const { r, f } = await run(
      w,
      [
        { status: 200, body: reply('{"tool": "search_knowledge", "arguments": {"query": "file Q.MRL.EVT saturee"}}') },
        { status: 200, body: reply('{"answer": "Voir https://wiki.example.local/7001 et https://evil.example.com/q"}') },
      ],
      { toolsMode: 'json' },
    );
    assert.equal(r.toolsMode, 'json');
    assert.match(f.calls[1].body.messages.at(-1).content, /File pleine/);
    assert.equal(r.answer, 'Voir https://wiki.example.local/7001 et');
    assert.deepEqual(r.removedLinks, ['https://evil.example.com/q']);
    assert.deepEqual(r.sources.map((s) => s.id), [w.ficheId]);
  });

  test('open_fiche with an unknown id returns an error and no source', async () => {
    const w = world();
    const { r, f } = await run(w, [
      { status: 200, body: reply('', { tool_calls: [toolCall('1', 'open_fiche', { id: 'fiche:nope' })] }) },
      { status: 200, body: reply('Introuvable.') },
    ]);
    assert.match(JSON.parse(f.calls[1].body.messages.at(-1).content).error, /fiche inconnue/);
    assert.deepEqual(r.sources, []);
  });

  test('underscore inside an allowed url is kept, with or without bold', async () => {
    const u = 'https://wiki.example.local/display/EXPL/Page_name';
    const w = world({ url: u });
    const text = `${u} puis **${u}** et _${u}_ fin`;
    const { r } = await run(w, [...calls(w), { status: 200, body: reply(text) }]);
    assert.deepEqual(r.removedLinks, []);
    assert.equal(r.answer, text);
  });

  test('a disallowed url in underscores leaves no doubled underscores', async () => {
    const w = world();
    const { r } = await run(w, [...calls(w), { status: 200, body: reply('Avant _https://evil.example.com/p_ apres') }]);
    assert.equal(r.answer, 'Avant apres');
    assert.deepEqual(r.removedLinks, ['https://evil.example.com/p']);
  });

  test('open_fiche throwing does not break the chat', async () => {
    const w = world();
    w.repo.getNode = () => {
      throw new Error('base illisible');
    };
    const { r, f } = await run(w, [
      { status: 200, body: reply('', { tool_calls: [toolCall('1', 'open_fiche', { id: 'x' })] }) },
      { status: 200, body: reply('Je ne peux pas ouvrir la fiche.') },
    ]);
    assert.deepEqual(JSON.parse(f.calls[1].body.messages.at(-1).content), { error: 'recherche indisponible' });
    assert.match(r.answer, /ne peux pas/);
    assert.deepEqual(r.sources, []);
  });

  test('no knowledge given: ask still works', async () => {
    const repo = createRepo(openStore(':memory:'));
    const llm = createLlmClient(baseCfg, { fetch: fakeFetch([{ status: 200, body: reply('ok') }]), logger: silent });
    const r = await ask({ llm, repo, question: 'x' });
    assert.deepEqual([r.answer, r.sources, r.removedLinks], ['ok', [], []]);
  });
});
