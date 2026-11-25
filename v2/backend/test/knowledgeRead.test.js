'use strict';
const assert = require('assert').strict;
const { sanitizeFiches, mergeFicheReadings, OPS_VERSION } = require('../src/knowledge/schema');
const { buildFicheMessages } = require('../src/knowledge/prompt');
const { readFiches } = require('../src/knowledge/readFiches');
const { createLlmClient } = require('../src/lib/llmClient');

const APPS = [{ name: 'Portail Adhérents', aliases: ['PDA'] }];
const it0 = (text, evidence = text) => ({ text, evidence });

const incident = (over = {}) => ({
  kind: 'incident',
  title: it0('Page blanche sur le portail'),
  section: 'Incidents connus',
  date: it0('12/03/2026'),
  fields: { symptoms: it0('page blanche après connexion'), cause: it0('cache saturé'), solution: it0('vider le cache puis relancer'), goal: it0('hors type') },
  lists: { errors: [it0('Erreur 502 Bad Gateway')], actions: [it0('relancer le service')], tickets: [], steps: [it0('hors type')] },
  apps: [it0('PDA')],
  servers: [it0('srv-app-01')],
  keywords: ['page blanche', 'écran vide'],
  replaces: null,
  fixes: null,
  ...over,
});

function mockLlm(answers, bodies = []) {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  return createLlmClient(
    { mock: true, models: { extract: 'm' }, cacheDir: null, concurrency: 1, maxRetries: 0, jsonMode: true },
    { logger: silent, mockHandler: (ep, body) => (bodies.push(body), { choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }) }
  );
}

describe('lecture IA des fiches', () => {
  test('OPS_VERSION is 1', () => {
    assert.equal(OPS_VERSION, 1);
  });

  test('sanitize keeps allowed kinds and fields only', () => {
    const r = sanitizeFiches({ fiches: [incident(), { ...incident(), kind: 'blog' }, incident({ kind: ' Incident ' })] });
    assert.equal(r.fiches.length, 2); // « blog » écarté, casse et espaces tolérés
    const f = r.fiches[0];
    assert.equal(f.kind, 'incident');
    assert.deepEqual(Object.keys(f.fields).sort(), ['cause', 'solution', 'symptoms']);
    assert.deepEqual(Object.keys(f.lists).sort(), ['actions', 'errors', 'tickets']);
    assert.equal(f.section, 'Incidents connus');
    assert.deepEqual(f.title, it0('Page blanche sur le portail'));
    assert.deepEqual(f.apps, [it0('PDA')]);
    assert.equal(f.replaces, null);
  });

  test('item without evidence is dropped', () => {
    const r = sanitizeFiches({
      fiches: [incident({ fields: { symptoms: { text: 'sans preuve' }, cause: it0('cache saturé') }, lists: { errors: [{ text: 'x', evidence: '' }, it0('Erreur 500')] }, date: { text: '12/03' } })],
    });
    const f = r.fiches[0];
    assert.deepEqual(Object.keys(f.fields), ['cause']);
    assert.deepEqual(f.lists.errors, [it0('Erreur 500')]);
    assert.equal(f.date, null);
    // un titre sans citation écarte la fiche
    assert.equal(sanitizeFiches({ fiches: [incident({ title: { text: 'Titre' } })] }).fiches.length, 0);
  });

  test('personal data is removed from items', () => {
    const f = sanitizeFiches({ fiches: [incident({ fields: { cause: { text: 'écrire à jean.dupont@exemple.fr', evidence: 'écrire à jean.dupont@exemple.fr pour le cache' } } })] }).fiches[0];
    assert.ok(!/@/.test(f.fields.cause.text + f.fields.cause.evidence));
  });

  test('keywords are capped to 12 short strings', () => {
    const many = Array.from({ length: 20 }, (_, i) => `mot ${i}`);
    const f = sanitizeFiches({ fiches: [incident({ keywords: ['x'.repeat(200), ...many, 'Mot 1', 42, null] })] }).fiches[0];
    assert.equal(f.keywords.length, 12);
    assert.ok(f.keywords.every((k) => typeof k === 'string' && k.length <= 60));
    assert.equal(f.keywords[0], 'mot 0');
  });

  test('merge of chunks fuses same kind and title', () => {
    const a = sanitizeFiches({ fiches: [incident({ keywords: ['page blanche'] })] });
    const b = sanitizeFiches({
      fiches: [
        incident({ title: it0('page  BLANCHE sur le portail'), fields: { solution: it0('autre') }, lists: { errors: [it0('Erreur 502 Bad Gateway'), it0('Erreur 504')] }, keywords: ['écran vide', 'lenteur'] }),
        incident({ title: it0('Autre incident') }),
      ],
    });
    const m = mergeFicheReadings([a, b]);
    assert.equal(m.fiches.length, 2);
    const f = m.fiches[0];
    assert.equal(f.fields.solution.text, 'vider le cache puis relancer');
    assert.deepEqual(f.lists.errors.map((e) => e.text), ['Erreur 502 Bad Gateway', 'Erreur 504']);
    assert.deepEqual(f.keywords, ['page blanche', 'écran vide', 'lenteur']);
    // même titre, autre type : pas fusionné
    const p = sanitizeFiches({ fiches: [{ kind: 'procedure', title: it0('Page blanche sur le portail'), lists: { steps: [it0('étape 1')] } }] });
    assert.equal(mergeFicheReadings([a, p]).fiches.length, 2);
  });

  test('readFiches calls the model once per chunk with the page kind', async () => {
    const bodies = [];
    const llm = mockLlm([{ fiches: [incident()] }, { fiches: [incident({ lists: { errors: [it0('Erreur 504')] } })] }], bodies);
    const sections = [
      { heading: 'A', text: 'a '.repeat(200) },
      { heading: 'B', text: 'b '.repeat(200) },
    ];
    const r = await readFiches(llm, { title: 'Incidents', ancestors: ['Exploitation'], today: '2026-11-24', kind: 'incident', sections, apps: APPS, consignes: { text: 'Les serveurs srv-* sont en production.', hash: 'h' } }, { chunkChars: 500, maxTokens: 2048 });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 2048);
    assert.equal(bodies[0].temperature, 0);
    const sys = bodies[0].messages.find((m) => m.role === 'system').content;
    const usr = bodies[0].messages.find((m) => m.role === 'user').content;
    assert.match(sys, /Portail Adhérents/);
    assert.match(sys, /srv-\* sont en production/);
    assert.match(usr, /Nature de la page : incident/);
    assert.match(usr, /Morceau 1 sur 2/);
    assert.equal(r.fiches.length, 1);
    assert.deepEqual(r.fiches[0].lists.errors.map((e) => e.text), ['Erreur 502 Bad Gateway', 'Erreur 504']);
  });

  test('empty answer gives no fiche', async () => {
    const llm = mockLlm([{ fiches: [] }]);
    const r = await readFiches(llm, { title: 'Page', text: 'Rien d\'opérationnel ici.', kind: 'other', apps: APPS });
    assert.deepEqual(r, { fiches: [] });
    // page sans texte : aucun appel
    const none = await readFiches({ chatJson: () => assert.fail('appel inattendu') }, { title: 'Vide', text: '', kind: 'other', apps: APPS });
    assert.deepEqual(none, { fiches: [] });
  });

  test('prompt carries the rules and no long dash', () => {
    const [sys] = buildFicheMessages({ title: 'T', text: 'x', apps: APPS });
    assert.match(sys.content, /mot pour mot/);
    assert.match(sys.content, /replaces/);
    assert.ok(![...sys.content].some((c) => [0x2013, 0x2014].includes(c.codePointAt(0))));
  });
});
