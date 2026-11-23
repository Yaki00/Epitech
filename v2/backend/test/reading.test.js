'use strict';
const assert = require('assert').strict;
const { sanitizeReading, mergeReadings } = require('../src/reading/schema');
const { buildReadingMessages } = require('../src/reading/prompt');
const { readPage, READING_VERSION } = require('../src/reading/readPage');
const { diagramsToText } = require('../src/parse/confluence/drawioText');
const { LlmError, createLlmClient } = require('../src/lib/llmClient');

const APPS = [
  { name: 'Portail Adhérents', aliases: ['PDA'] },
  { name: 'Facturation', aliases: [] },
];

const emptyReading = (over = {}) => ({
  page: { kind: 'architecture', period: 'current', env: null, topics: [] },
  applications: [],
  entities: [],
  links: [],
  owners: [],
  ...over,
});

/** Faux client : rend les réponses préparées dans l'ordre et garde les appels. */
function fakeLlm(responses) {
  const calls = [];
  return {
    calls,
    async chatJson(params) {
      calls.push(params);
      const r = responses[calls.length - 1];
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error('appel inattendu');
      return JSON.parse(JSON.stringify(r));
    },
  };
}

const userText = (call) => call.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
const systemText = (call) => call.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

describe('lecture IA d\'une page', () => {
  test('READING_VERSION is 3 (date du jour, période par lien, environnement cité, définition de architecture)', () => {
    assert.equal(READING_VERSION, 3);
  });

  test('sanitize keeps only allowed values', () => {
    const r = sanitizeReading({
      page: { kind: 'blog', period: 'someday', env: 'prd', topics: ['servers', 'weather', 'contacts', 'servers'] },
      applications: [
        { name: 'Portail Adhérents', written: 'PDA', role: 'main', evidence: 'le PDA tourne sur' },
        { name: 'Facturation', role: 'cited', evidence: 'appelle Facturation' },
      ],
      entities: [
        { name: 'srv-app-01', type: 'server', env: 'PROD', status: 'gone', evidence: 'srv-app-01 (production)' },
        { name: 'srv-db-01', type: 'server', env: 'STG', status: 'decommissioned', evidence: 'srv-db-01 arrêté' },
        { name: 'truc', type: 'gadget', env: null, status: 'active', evidence: 'truc' },
      ],
      links: [
        { from: 'Portail Adhérents', to: 'srv-app-01', type: 'runs_on', evidence: 'le PDA tourne sur srv-app-01' },
        { from: 'Portail Adhérents', to: 'Facturation', type: 'loves', evidence: 'aime Facturation' },
      ],
      owners: [
        { name: 'Équipe Socle', kind: 'team', application: 'Portail Adhérents', role: 'boss', evidence: 'Équipe Socle : support' },
        { name: 'Alice Martin', kind: 'robot', application: null, role: 'owner', evidence: 'Alice Martin' },
      ],
    });
    assert.deepEqual(r.page, { kind: 'other', period: null, env: 'PRD', envEvidence: null, topics: ['servers', 'contacts'] });
    assert.deepEqual(
      r.applications.map((a) => [a.name, a.written, a.role]),
      [
        ['Portail Adhérents', 'PDA', 'cited'],
        ['Facturation', 'Facturation', 'cited'],
      ]
    );
    assert.deepEqual(
      r.entities.map((e) => [e.name, e.type, e.env, e.status]),
      [
        ['srv-app-01', 'server', 'PRD', null],
        ['srv-db-01', 'server', 'STG', 'decommissioned'],
      ]
    );
    assert.deepEqual(r.links.map((l) => l.type), ['runs_on']);
    assert.deepEqual(r.owners.map((o) => [o.name, o.kind, o.role]), [['Équipe Socle', 'team', 'other']]);
  });

  test('sanitize tolerates missing or broken parts', () => {
    const r = sanitizeReading({ page: null, applications: 'x', entities: [null, 3], links: undefined });
    assert.deepEqual(r, emptyReading({ page: { kind: 'other', period: 'current', env: null, envEvidence: null, topics: [] } }));
    assert.deepEqual(sanitizeReading(null).applications, []);
    const o = sanitizeReading({ page: {}, owners: [{ name: 'Équipe Socle', kind: 'team', application: 'null', role: 'support', evidence: 'Équipe Socle' }] });
    assert.equal(o.owners[0].application, null);
  });

  test('duplicates are merged inside one reading', () => {
    const r = sanitizeReading({
      page: { kind: 'architecture', period: 'current' },
      applications: [
        { name: 'Facturation', written: 'Facturation', role: 'cited', evidence: 'appelle Facturation' },
        { name: 'facturation ', written: 'FACT', role: 'subject', evidence: 'La Facturation' },
      ],
      entities: [
        { name: 'srv-app-01', type: 'server', env: null, status: 'active', evidence: 'srv-app-01' },
        { name: 'SRV-APP-01', type: 'server', env: 'PRD', status: 'decommissioned', evidence: 'SRV-APP-01 arrêté' },
      ],
      links: [
        { from: 'Facturation', to: 'srv-app-01', type: 'runs_on', evidence: 'a' },
        { from: 'facturation', to: 'SRV-APP-01', type: 'runs_on', evidence: 'b' },
      ],
    });
    assert.equal(r.applications.length, 1);
    assert.equal(r.applications[0].role, 'subject');
    assert.equal(r.entities.length, 1);
    assert.deepEqual([r.entities[0].env, r.entities[0].status], ['PRD', 'decommissioned']);
    assert.equal(r.links.length, 1);
  });

  test('environment synonyms come only from the configuration (mappings.json), not from the code', () => {
    const { configureEnvironments } = require('../src/lib/environment');
    const raw = { page: { kind: 'other', period: 'current', env: 'recette', topics: [] }, entities: [{ name: 'srv-u', type: 'server', env: 'UAT', status: 'active', evidence: 'srv-u' }] };
    assert.equal(sanitizeReading(raw).page.env, null);
    configureEnvironments({ STG: ['recette', 'uat'] });
    try {
      const r = sanitizeReading(raw);
      assert.equal(r.page.env, 'STG');
      assert.equal(r.entities[0].env, 'STG');
    } finally {
      configureEnvironments(null);
    }
  });

  test('french enum values are mapped (ancienne → past, décommissionné → decommissioned, sujet → subject)', () => {
    const r = sanitizeReading({
      page: { kind: 'Réunion', period: 'Ancienne', env: 'recette', topics: [] },
      applications: [
        { name: 'Facturation', role: 'sujet', evidence: 'Facturation' },
        { name: 'Portail Adhérents', role: 'Cité', evidence: 'PDA' },
      ],
      entities: [
        { name: 'srv-a', type: 'server', env: 'production', status: 'décommissionné', evidence: 'srv-a' },
        { name: 'srv-b', type: 'server', env: 'Développement', status: 'Prévu', evidence: 'srv-b' },
        { name: 'srv-c', type: 'server', env: 'UAT', status: 'en service', evidence: 'srv-c' },
        { name: 'srv-d', type: 'server', env: 'preprod', status: 'Arrêté', evidence: 'srv-d' },
      ],
      owners: [{ name: 'Alice Martin', kind: 'person', application: null, role: 'Responsable', evidence: 'Alice Martin' }],
    });
    // « recette » et « UAT » : vocabulaire maison, sans synonyme réglé ils ne donnent aucun environnement
    assert.deepEqual(r.page, { kind: 'meeting', period: 'past', env: null, envEvidence: null, topics: [] });
    assert.deepEqual(r.applications.map((a) => a.role), ['subject', 'cited']);
    assert.deepEqual(
      r.entities.map((e) => [e.name, e.env, e.status]),
      [
        ['srv-a', 'PRD', 'decommissioned'],
        ['srv-b', 'DEV', 'planned'],
        ['srv-c', null, 'active'],
        ['srv-d', 'STG', 'decommissioned'],
      ]
    );
    assert.equal(r.owners[0].role, 'owner');
    assert.equal(sanitizeReading({ page: { period: 'cible' } }).page.period, 'target');
    assert.equal(sanitizeReading({ page: { period: 'Actuelle' } }).page.period, 'current');
    assert.equal(sanitizeReading({ page: { kind: 'Exploitation' } }).page.kind, 'operations');
  });

  test('unknown non-empty period and status become null', () => {
    const r = sanitizeReading({
      page: { kind: 'architecture', period: 'bientôt peut-être' },
      entities: [
        { name: 'srv-a', type: 'server', status: 'en sommeil', evidence: 'srv-a' },
        { name: 'srv-b', type: 'server', status: 'active', evidence: 'srv-b' },
        { name: 'srv-b', type: 'server', status: '???', evidence: 'srv-b encore' },
        { name: 'srv-c', type: 'server', status: '???', evidence: 'srv-c' },
        { name: 'srv-c', type: 'server', status: 'decommissioned', evidence: 'srv-c arrêté' },
      ],
    });
    assert.equal(r.page.period, null);
    // fusion prudente : arrêté ou prévu, puis non fiable, puis actif
    assert.deepEqual(r.entities.map((e) => [e.name, e.status]), [['srv-a', null], ['srv-b', null], ['srv-c', 'decommissioned']]);
    // période non fiable au premier morceau : une période ancienne ou cible plus loin est reprise
    const merged = mergeReadings([r, sanitizeReading({ page: { period: 'current' } }), sanitizeReading({ page: { period: 'target' } })]);
    assert.equal(merged.page.period, 'target');
    assert.equal(mergeReadings([r, sanitizeReading({ page: { period: 'current' } })]).page.period, null);
  });

  test('missing period and status keep defaults', () => {
    const r = sanitizeReading({
      page: { kind: 'architecture', period: '' },
      entities: [
        { name: 'srv-a', type: 'server', evidence: 'srv-a' },
        { name: 'srv-b', type: 'server', status: '  ', evidence: 'srv-b' },
        { name: 'srv-c', type: 'server', status: 'null', evidence: 'srv-c' },
      ],
    });
    assert.equal(r.page.period, 'current');
    assert.equal(sanitizeReading({ page: {} }).page.period, 'current');
    assert.deepEqual(r.entities.map((e) => e.status), ['active', 'active', 'active']);
  });

  test('items without evidence are dropped', () => {
    const r = sanitizeReading({
      page: { kind: 'architecture', period: 'current', env: null, topics: [] },
      applications: [{ name: 'Facturation', role: 'subject' }, { name: 'Portail Adhérents', role: 'cited', evidence: '  ' }],
      entities: [
        { name: 'srv-app-01', type: 'server', status: 'active' },
        { name: 'srv-app-02', type: 'server', status: 'active', evidence: 'srv-app-02' },
      ],
      links: [{ from: 'Facturation', to: 'srv-app-01', type: 'runs_on', evidence: null }],
      owners: [{ name: 'Alice Martin', kind: 'person', role: 'owner' }],
    });
    assert.deepEqual(r.applications, []);
    assert.deepEqual(r.entities.map((e) => e.name), ['srv-app-02']);
    assert.deepEqual(r.links, []);
    assert.deepEqual(r.owners, []);
  });

  test('emails and phone numbers are removed from owners', () => {
    const r = sanitizeReading({
      page: { kind: 'operations', period: 'current' },
      owners: [
        {
          name: 'Alice Martin alice.martin@example.org',
          kind: 'person',
          application: 'Facturation',
          role: 'owner',
          evidence: 'Responsable : Alice Martin (alice.martin@example.org, 01 23 45 67 89)',
        },
        { name: 'Équipe Socle', kind: 'team', application: null, role: 'oncall', evidence: 'Astreinte Équipe Socle +33 6 12 34 56 78' },
        { name: 'bob@example.org', kind: 'person', application: null, role: 'support', evidence: 'bob@example.org' },
        { name: '06 12 34 56 78', kind: 'person', application: null, role: 'support', evidence: 'Support 06 12 34 56 78' },
      ],
      entities: [
        { name: 'carol@example.org', type: 'person', status: 'active', evidence: 'carol@example.org' },
        { name: '10.12.40.21', type: 'ip', status: 'active', evidence: 'IP 10.12.40.21' },
      ],
    });
    assert.deepEqual(
      r.owners.map((o) => [o.name, o.role]),
      [
        ['Alice Martin', 'owner'],
        ['Équipe Socle', 'oncall'],
      ]
    );
    const all = JSON.stringify(r.owners);
    assert.ok(!/@/.test(all), all);
    assert.ok(!/45 67 89|56 78/.test(all), all);
    assert.ok(r.owners[0].evidence.includes('Alice Martin'));
    // une IP n'est pas un numéro de téléphone ; une adresse électronique n'est pas une personne
    assert.deepEqual(r.entities.map((e) => e.name), ['10.12.40.21']);
  });

  test('diagramsToText writes one line per arrow and per containment', () => {
    const drawio = {
      pages: [
        {
          name: 'Flux',
          nodes: [],
          edges: [
            { sourceLabel: 'Portail', targetLabel: 'srv-app-01', label: 'HTTPS' },
            { sourceLabel: 'srv-app-01', targetLabel: 'BDD Facturation', label: null },
            { sourceLabel: null, targetLabel: 'srv-app-01', label: 'orpheline' },
          ],
          containment: [{ parentLabel: 'Zone PRD', childLabel: 'srv-app-01' }],
        },
      ],
    };
    const text = diagramsToText([drawio, { pages: [{ name: 'Vide', nodes: [], edges: [], containment: [] }] }]);
    assert.deepEqual(text.split('\n'), [
      'Schéma Flux : Portail → srv-app-01 (HTTPS)',
      'Schéma Flux : srv-app-01 → BDD Facturation',
      'Schéma Flux : Zone PRD contient srv-app-01',
    ]);
    assert.equal(diagramsToText([]), '');
    assert.equal(diagramsToText(undefined), '');
  });

  test('consignes appear in system message', () => {
    const messages = buildReadingMessages({
      title: 'Architecture Facturation',
      ancestors: ['Applications', 'Facturation'],
      space: 'DOC',
      updatedAt: '2026-01-10T10:00:00Z',
      text: 'Facturation tourne sur srv-app-01.',
      diagramsText: 'Schéma Flux : Portail → srv-app-01 (HTTPS)',
      apps: APPS,
      consignes: 'Les serveurs de recette finissent par r.',
    });
    const system = messages.find((m) => m.role === 'system').content;
    assert.ok(system.includes("Consignes de l'entreprise"));
    assert.ok(system.indexOf("Consignes de l'entreprise") < system.indexOf('Les serveurs de recette finissent par r.'));
    assert.ok(system.trim().endsWith('Les serveurs de recette finissent par r.'));
    assert.ok(system.includes('Portail Adhérents') && system.includes('PDA'));
    const user = messages.find((m) => m.role === 'user').content;
    for (const s of ['Architecture Facturation', 'Applications > Facturation', 'DOC', '2026-01-10', 'srv-app-01.', 'Schéma Flux']) {
      assert.ok(user.includes(s), s);
    }
    // sans consignes : pas de titre vide
    const bare = buildReadingMessages({ title: 'T', text: 'x', apps: APPS, consignes: '' });
    assert.ok(!bare[0].content.includes("Consignes de l'entreprise"));
    // aucun tiret long ni demi-cadratin dans les consignes système
    assert.ok(!/[\u2013\u2014]/.test(system));
    // valeurs de liste à garder en anglais, montrées dans le squelette
    assert.ok(system.includes('ne les traduis pas'));
    assert.ok(system.includes('"period": "current|past|target"'));
  });

  test('short page makes one extract call', async () => {
    const llm = fakeLlm([
      emptyReading({
        applications: [{ name: 'Facturation', written: 'Facturation', role: 'subject', evidence: 'Facturation tourne' }],
      }),
    ]);
    const r = await readPage(llm, { title: 'Architecture Facturation', text: 'Facturation tourne sur srv-app-01.', apps: APPS, consignes: '' }, { maxTokens: 4096 });
    assert.equal(llm.calls.length, 1);
    const c = llm.calls[0];
    assert.equal(c.task, 'extract');
    assert.equal(c.temperature, 0);
    assert.equal(c.maxTokens, 4096);
    assert.ok(c.schema && c.schema.page === 'object');
    assert.deepEqual(r.applications.map((a) => a.name), ['Facturation']);
    assert.equal(r.page.kind, 'architecture');
  });

  test('long page is chunked and merged, title sent to every chunk', async () => {
    const para = (tag) => `${tag} `.repeat(60).trim();
    const sections = [
      { heading: 'Contexte', text: `Le Portail Adhérents (PDA) sert les adhérents. ${para('alpha')}` },
      { heading: 'Serveurs', text: `srv-app-01 en production. ${para('beta')}` },
      { heading: 'Contacts', text: `Responsable : Alice Martin. ${para('gamma')}` },
    ];
    const llm = fakeLlm([
      {
        page: { kind: 'other', period: 'current', env: null, topics: [] },
        applications: [{ name: 'Portail Adhérents', written: 'PDA', role: 'cited', evidence: 'Le Portail Adhérents (PDA)' }],
        entities: [],
        links: [],
        owners: [],
      },
      {
        page: { kind: 'architecture', period: 'past', env: 'PRD', topics: ['servers'] },
        applications: [{ name: 'Portail Adhérents', written: 'Portail', role: 'subject', evidence: 'srv-app-01' }],
        entities: [{ name: 'srv-app-01', type: 'server', env: 'PRD', status: 'active', evidence: 'srv-app-01 en production' }],
        links: [{ from: 'Portail Adhérents', to: 'srv-app-01', type: 'runs_on', evidence: 'srv-app-01 en production' }],
        owners: [],
      },
      {
        page: { kind: 'operations', period: 'current', env: null, topics: ['contacts'] },
        applications: [],
        entities: [{ name: 'SRV-APP-01', type: 'server', env: null, status: 'active', evidence: 'srv-app-01' }],
        links: [{ from: 'Portail Adhérents', to: 'srv-app-01', type: 'runs_on', evidence: 'autre citation' }],
        owners: [{ name: 'Alice Martin', kind: 'person', application: 'Portail Adhérents', role: 'owner', evidence: 'Responsable : Alice Martin' }],
      },
    ]);
    const r = await readPage(
      llm,
      { title: 'Portail Adhérents : DAT', ancestors: ['Applications'], sections, apps: APPS, consignes: 'Consigne X' },
      { chunkChars: 450, maxTokens: 4096 }
    );
    assert.equal(llm.calls.length, 3);
    llm.calls.forEach((c, i) => {
      assert.ok(userText(c).includes('Portail Adhérents : DAT'), `titre absent du morceau ${i + 1}`);
      assert.ok(systemText(c).includes('Consigne X'));
      assert.ok(userText(c).includes(`${i + 1} sur 3`));
    });
    // chaque section dans un seul morceau, jamais coupée
    assert.ok(userText(llm.calls[0]).includes('alpha') && !userText(llm.calls[0]).includes('beta'));
    assert.ok(userText(llm.calls[1]).includes('beta') && !userText(llm.calls[1]).includes('gamma'));
    assert.ok(userText(llm.calls[2]).includes('gamma'));
    // applications reconnues transmises aux morceaux suivants
    assert.ok(!/déjà reconnues/.test(userText(llm.calls[0])));
    assert.ok(/déjà reconnues[^\n]*Portail Adhérents/.test(userText(llm.calls[1])));
    // fusion
    assert.equal(r.page.kind, 'architecture'); // le premier morceau disait other
    assert.equal(r.page.period, 'current'); // la période vient du premier morceau
    assert.equal(r.page.env, 'PRD');
    assert.deepEqual(r.page.topics, ['servers', 'contacts']);
    assert.equal(r.applications.length, 1);
    assert.deepEqual([r.applications[0].role, r.applications[0].written], ['subject', 'PDA']);
    assert.equal(r.entities.length, 1);
    assert.equal(r.entities[0].env, 'PRD');
    assert.equal(r.links.length, 1);
    assert.equal(r.links[0].evidence, 'srv-app-01 en production');
    assert.deepEqual(r.owners.map((o) => o.name), ['Alice Martin']);
  });

  test('oversized section is split on paragraphs', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `ligne${i} ${'x'.repeat(90)}`);
    const llm = fakeLlm([emptyReading(), emptyReading(), emptyReading(), emptyReading(), emptyReading(), emptyReading()]);
    await readPage(llm, { title: 'T', sections: [{ heading: 'Serveurs', text: lines.join('\n') }], apps: APPS }, { chunkChars: 250 });
    assert.ok(llm.calls.length >= 3);
    const seen = llm.calls.map(userText).join('\n');
    for (const l of lines) assert.ok(seen.includes(l), l);
    // aucun paragraphe coupé
    for (const c of llm.calls) for (const l of lines) assert.ok(!userText(c).includes(l.slice(0, 20)) || userText(c).includes(l));
  });

  test('readPage goes through the real client schema check', async () => {
    const bodies = [];
    const answers = [JSON.stringify({ applications: [] }), JSON.stringify(emptyReading({ page: { kind: 'release', period: 'current', env: 'PRD', topics: [] } }))];
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const llm = createLlmClient(
      { mock: true, models: { extract: 'm' }, cacheDir: null, concurrency: 1, maxRetries: 0, jsonMode: true },
      { logger: silent, mockHandler: (ep, body) => (bodies.push(body), { choices: [{ message: { content: answers.shift() } }] }) }
    );
    const r = await readPage(llm, { title: 'Mise en production', text: 'MEP du 12/03.', apps: APPS }, { maxTokens: 4096 });
    assert.equal(r.page.kind, 'release');
    assert.equal(bodies.length, 2); // réponse sans « page » renvoyée une fois au modèle
    assert.equal(bodies[0].max_tokens, 4096);
    assert.equal(bodies[0].temperature, 0);
  });

  test('failing chunk rejects the page', async () => {
    const sections = [
      { heading: 'A', text: 'a '.repeat(200) },
      { heading: 'B', text: 'b '.repeat(200) },
    ];
    const llm = fakeLlm([emptyReading(), new LlmError('Réponse coupée', { code: 'truncated' })]);
    await assert.rejects(readPage(llm, { title: 'T', sections, apps: APPS }, { chunkChars: 450 }), (err) => err.code === 'truncated');
    assert.equal(llm.calls.length, 2);
  });
});

describe('ip des serveurs', () => {
  test('server ip is kept, non-ip value dropped', () => {
    const r = sanitizeReading({
      entities: [
        { name: 'srv1', type: 'server', ip: ' 10.1.2.3 ', evidence: 'srv1 10.1.2.3' },
        { name: 'srv2', type: 'server', ip: 'pas une ip', evidence: 'srv2 pas une ip' },
        { name: 'srv3', type: 'server', ip: '999.1.1.1', evidence: 'srv3 999.1.1.1' },
        { name: 'ora', type: 'database', ip: '10.1.2.4', evidence: 'ora 10.1.2.4' },
      ],
    });
    assert.deepEqual(r.entities.map((e) => e.ip), ['10.1.2.3', null, null, null]);
  });
});

describe('règle des tableaux de serveurs (consignes système)', () => {
  test('the system prompt states that a server or database table of an architecture page gives runs_on / uses_db / db_on', () => {
    const [system] = buildReadingMessages({ title: 'T', text: 'x', apps: APPS });
    assert.match(system.content, /tableau qui liste les serveurs \(ou les bases\)/);
    assert.match(system.content, /runs_on \(application vers chaque serveur du tableau\)/);
    assert.match(system.content, /« \| »/);
    assert.ok(READING_VERSION >= 2);
  });

  test('a table row quote is accepted as evidence for a runs_on link', () => {
    const { openStore } = require('../src/store/store');
    const { createRepo } = require('../src/store/repo');
    const { createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
    const { verifyReading } = require('../src/reading/verify');
    const repo = createRepo(openStore(':memory:'));
    const perimeter = { applications: [{ name: 'Facturation', aliases: [] }], ignoreOtherApplications: true };
    ensurePerimeterNodes(repo, perimeter);
    // texte d'un tableau tel que la page le rend : cellules séparées par « | »
    const pageText = 'Facturation : architecture\nServeur | Environnement | IP\nsrvfac01 | PRD | 10.1.2.3';
    const reading = sanitizeReading({
      page: { kind: 'architecture', period: 'current', env: null, topics: ['servers'] },
      applications: [{ name: 'Facturation', written: 'Facturation', role: 'subject', evidence: 'Facturation : architecture' }],
      entities: [{ name: 'srvfac01', type: 'server', env: 'PRD', ip: '10.1.2.3', status: 'active', evidence: 'srvfac01 | PRD | 10.1.2.3' }],
      links: [{ from: 'Facturation', to: 'srvfac01', type: 'runs_on', evidence: 'srvfac01 | PRD | 10.1.2.3' }],
    });
    const v = verifyReading(reading, { pageText, repo, matcher: createMatcher(perimeter, repo), naemonHosts: new Set(), pageUpdatedAt: '2026-10-01T00:00:00Z', now: Date.parse('2026-11-23T00:00:00Z') });
    assert.deepEqual(v.rejected, []);
    assert.deepEqual(v.links.map((l) => [l.src, l.type, l.dst, l.trust]), [['application:facturation', 'runs_on', 'server:srvfac01', 'added']]);
  });
});


describe('banc 1 : date du jour, période par lien, environnement de page, nature architecture', () => {
  const { pageHeaderLines, SYSTEM } = require('../src/reading/prompt');

  test('the date of the day is written in the header, never in the quotable header lines', () => {
    const messages = buildReadingMessages({ title: 'Plan de capacité 2026', ancestors: ['Exploitation'], updatedAt: '2026-02-01T10:00:00Z', today: '2026-11-23', text: 'x', apps: APPS });
    const user = messages.find((m) => m.role === 'user').content;
    assert.ok(user.includes('Date du jour : 2026-11-23'));
    assert.ok(user.includes('Dernière modification : 2026-02-01'));
    // les lignes ajoutées au texte contrôlé (citations) ne contiennent pas la date du jour
    assert.ok(!pageHeaderLines({ title: 'Plan de capacité 2026', ancestors: ['Exploitation'] }).join('\n').includes('Date du jour'));
    // sans date fournie : pas de ligne
    const bare = buildReadingMessages({ title: 'T', text: 'x', apps: APPS });
    assert.ok(!bare[1].content.includes('Date du jour'));
    // le prompt dit de juger la période par rapport à cette date
    assert.match(SYSTEM, /date du jour/);
    assert.match(SYSTEM, /L'année en cours est actuelle/);
  });

  test('readPage passes the date of the day to every chunk', async () => {
    const llm = fakeLlm([emptyReading(), emptyReading()]);
    await readPage(llm, { title: 'Long', today: '2026-11-23', sections: [{ heading: 'A', text: 'a'.repeat(300) }, { heading: 'B', text: 'b'.repeat(300) }], apps: APPS }, { chunkChars: 400 });
    assert.equal(llm.calls.length, 2);
    for (const c of llm.calls) assert.ok(userText(c).includes('Date du jour : 2026-11-23'));
  });

  test('system prompt: architecture is installation, not a flow matrix ; env only when written ; link period', () => {
    assert.match(SYSTEM, /matrice des flux/);
    assert.match(SYSTEM, /n'est pas une page architecture/);
    assert.match(SYSTEM, /Jamais déduit des noms ou des adresses des serveurs/);
    assert.ok(SYSTEM.includes('"envEvidence"'));
    assert.ok(SYSTEM.includes('"period": "current|past|target|null"'));
    assert.match(SYSTEM, /marque chaque lien avec sa propre période/);
    assert.ok(!/[\u2013\u2014]/.test(SYSTEM));
  });

  test('link period: allowed values, french aliases, unreadable or missing = null (page period)', () => {
    const link = (period) => ({ from: 'A', to: 'srv1', type: 'runs_on', period, evidence: `A sur srv1 ${period}` });
    const r = sanitizeReading({
      page: { period: 'target' },
      links: [link('current'), { ...link('cible'), to: 'srv2' }, { ...link('Ancienne'), to: 'srv3' }, { ...link('existant'), to: 'srv4' }, { ...link('bientôt'), to: 'srv5' }, { ...link(undefined), to: 'srv6' }, { ...link('null'), to: 'srv7' }],
    });
    assert.deepEqual(r.links.map((l) => [l.to, l.period]), [
      ['srv1', 'current'],
      ['srv2', 'target'],
      ['srv3', 'past'],
      ['srv4', 'current'],
      ['srv5', null],
      ['srv6', null],
      ['srv7', null],
    ]);
  });

  test('same link seen twice: the current occurrence wins with its quote', () => {
    const r = sanitizeReading({
      links: [
        { from: 'A', to: 'srv1', type: 'db_on', period: 'past', evidence: 'en 2023 A rejoint srv1' },
        { from: 'A', to: 'srv1', type: 'db_on', period: 'current', evidence: 'aujourd hui A est sur srv1' },
      ],
    });
    assert.deepEqual(r.links.map((l) => [l.period, l.evidence]), [['current', 'aujourd hui A est sur srv1']]);
    // entre morceaux aussi
    const m = mergeReadings([
      sanitizeReading({ links: [{ from: 'A', to: 'srv1', type: 'db_on', period: 'target', evidence: 'cible : A sur srv1' }] }),
      sanitizeReading({ links: [{ from: 'A', to: 'srv1', type: 'db_on', period: 'current', evidence: 'existant : A sur srv1' }] }),
    ]);
    assert.deepEqual(m.links.map((l) => [l.period, l.evidence]), [['current', 'existant : A sur srv1']]);
  });

  test('page env keeps its quote; no env, no quote; merge keeps the env that has a quote', () => {
    assert.deepEqual(sanitizeReading({ page: { env: 'PRD', envEvidence: 'Serveurs de production' } }).page.envEvidence, 'Serveurs de production');
    assert.equal(sanitizeReading({ page: { env: null, envEvidence: 'Serveurs de production' } }).page.envEvidence, null);
    assert.equal(sanitizeReading({ page: { env: 'PRD', envEvidence: 'null' } }).page.envEvidence, null);
    const m = mergeReadings([sanitizeReading({ page: { env: 'PRD' } }), sanitizeReading({ page: { env: 'STG', envEvidence: 'Infra : recette STG' } })]);
    assert.deepEqual([m.page.env, m.page.envEvidence], ['STG', 'Infra : recette STG']);
  });
});
