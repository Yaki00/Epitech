'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createLlmClient } = require('../src/lib/llmClient');
const { loadPerimeter } = require('../src/perimeter/perimeter');
const { ingestInventory } = require('../src/ingest/inventory');
const { impactOf } = require('../src/graph/impact');
const { runConfluenceSync } = require('../src/reading/syncPages');
const { linkFiches } = require('../src/knowledge/apply');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const it0 = (text, evidence = text) => ({ text, evidence });
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const titleOf = (body) => (String(body.messages[1].content).match(/^Titre : (.*)$/m) || [])[1];
const isFicheCall = (body) => /fiches opérationnelles/.test(body.messages[0].content);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-fiches-'));

const T_INC = 'OrderHub - Incident lenteur';
const T_REL = 'OrderHub - Notes de version 4.2';
const T_OLD = 'OrderHub - Redemarrage 2025';
const T_NEW = 'OrderHub - Redemarrage 2026';
const T_MEET = 'CR reunion du 12/11';

const HTML = {
  [T_INC]:
    '<h2 id="lenteur">Lenteur du portail</h2><p>Symptome : le portail OrderHub est tres lent. Ticket INC-100 ouvert.</p>' +
    '<p>Solution : redemarrer le service orderhub-web sur srvorh01.</p><p><s>Ancienne solution : purger la base</s></p>',
  [T_REL]: '<h2>Correctifs 4.2</h2><p>Correction de la lenteur du portail (INC-100) dans OrderHub 4.2.</p>',
  [T_OLD]: '<h2>Redemarrer OrderHub</h2><p>Pour redemarrer OrderHub : arreter le service puis le relancer.</p>',
  [T_NEW]: '<h2>Redemarrer OrderHub en douceur</h2><p>Cette procedure remplace Redemarrer OrderHub : drainer puis arreter le service.</p>',
  [T_MEET]: '<p>Points divers. OrderHub passe en 4.2 bientot.</p>',
};
const OPS_TITLES = [T_INC, T_NEW, T_OLD, T_REL].sort();
const UPDATED = { [T_OLD]: '2025-03-01T10:00:00.000+01:00' };
const IDS = { [T_INC]: '8001', [T_REL]: '8002', [T_OLD]: '8003', [T_NEW]: '8004', [T_MEET]: '8005' };
const KIND = { [T_INC]: 'incident', [T_REL]: 'release', [T_OLD]: 'operations', [T_NEW]: 'operations', [T_MEET]: 'meeting' };

const readingOf = (title) => ({ page: { kind: KIND[title] || 'other', period: 'current', env: null, topics: [] }, applications: [], entities: [], links: [], owners: [] });

const FICHES = {
  [T_INC]: [
    {
      kind: 'incident', title: it0('Lenteur du portail'), section: 'Lenteur du portail', date: null,
      fields: { symptoms: it0('portail tres lent', 'le portail OrderHub est tres lent'), solution: it0('redemarrer le service orderhub-web', 'redemarrer le service orderhub-web sur srvorh01') },
      lists: { tickets: [it0('INC-100', 'Ticket INC-100 ouvert')] },
      apps: [it0('OrderHub', 'le portail OrderHub est tres lent')], servers: [it0('srvorh01', 'orderhub-web sur srvorh01')], keywords: ['lent', 'lenteur'], replaces: null, fixes: null,
    },
    {
      kind: 'procedure', title: it0('Redemarrer orderhub-web', 'redemarrer le service orderhub-web'), section: null, date: null,
      fields: {}, lists: { steps: [it0('redemarrer le service orderhub-web', 'redemarrer le service orderhub-web sur srvorh01')] },
      apps: [it0('OrderHub', 'le portail OrderHub est tres lent')], servers: [], keywords: [], replaces: null, fixes: null,
    },
  ],
  [T_REL]: [
    {
      kind: 'correctif', title: it0('Correction de la lenteur du portail'), section: 'Correctifs 4.2', date: null,
      fields: { version: it0('4.2', 'dans OrderHub 4.2') }, lists: { tickets: [it0('INC-100', '(INC-100)')] },
      apps: [it0('OrderHub', 'dans OrderHub 4.2')], servers: [], keywords: [], replaces: null, fixes: null,
    },
  ],
  [T_OLD]: [
    {
      kind: 'procedure', title: it0('Redemarrer OrderHub'), section: null, date: null, fields: { goal: it0('redemarrer OrderHub', 'Pour redemarrer OrderHub') },
      lists: { steps: [it0('arreter le service puis le relancer')] }, apps: [it0('OrderHub', 'Pour redemarrer OrderHub')], servers: [], keywords: [], replaces: null, fixes: null,
    },
  ],
  [T_NEW]: [
    {
      kind: 'procedure', title: it0('Redemarrer OrderHub en douceur'), section: null, date: null, fields: {},
      lists: { steps: [it0('drainer puis arreter le service')] }, apps: [it0('OrderHub', 'Redemarrer OrderHub en douceur')], servers: [], keywords: [],
      replaces: it0('Redemarrer OrderHub', 'Cette procedure remplace Redemarrer OrderHub'), fixes: null,
    },
  ],
  [T_MEET]: [],
};

function writePage(root, title) {
  const d = path.join(root, 'ESP', `${IDS[title]} - ${title.replace(/[^A-Za-z0-9 ]/g, '')}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'metadata.json'), JSON.stringify({ pageId: IDS[title], title, spaceKey: 'ESP', updatedAt: UPDATED[title] || '2026-11-01T10:00:00.000+01:00', version: 1, ancestors: [{ id: '1', title: 'Accueil' }], url: `https://wiki.example.local/${IDS[title]}` }));
  fs.writeFileSync(path.join(d, 'page.html'), HTML[title]);
}

function setup(titles = [T_INC, T_REL, T_OLD, T_NEW, T_MEET]) {
  const dir = tmp();
  const exportDir = path.join(dir, 'export');
  for (const t of titles) writePage(exportDir, t);
  fs.writeFileSync(path.join(dir, 'perimeter.json'), JSON.stringify({ applications: [{ name: 'OrderHub', aliases: ['ORH'] }] }));
  const perimeter = loadPerimeter(path.join(dir, 'perimeter.json'));
  const repo = createRepo(openStore(':memory:'));
  const mapping = { entity: 'server', key: 'Host', relations: [{ column: 'App', entity: 'application', type: 'runs_on', direction: 'from' }] };
  ingestInventory(repo, { source: 'apm', records: [{ App: 'OrderHub', Host: 'srvorh01' }], mapping });
  const state = { reading: [], fiche: [], ficheAnswer: (title) => ({ fiches: FICHES[title] || [] }), failFiches: false };
  const llm = createLlmClient(
    { mock: true, models: {}, concurrency: 2, maxRetries: 0, cacheDir: '' },
    {
      logger: silent,
      mockHandler: (endpoint, body) => {
        const title = titleOf(body);
        if (isFicheCall(body)) {
          state.fiche.push(title);
          if (state.failFiches) throw new Error('modele indisponible mot de passe : Azerty12');
          return reply(JSON.stringify(state.ficheAnswer(title)));
        }
        state.reading.push(title);
        return reply(JSON.stringify(readingOf(title)));
      },
    }
  );
  const sectionsFile = path.join(dir, 'data', 'knowledge-sections.json');
  const consignes = { text: 'Les serveurs commencent par srv.', hash: 'c1' };
  const run = (over = {}) => runConfluenceSync({ repo, exportDir, llm, perimeter, consignes, naemonHosts: [], now: NOW, log: silent, knowledgeSectionsFile: sectionsFile, ...over });
  const reset = () => ((state.reading = []), (state.fiche = []));
  return { dir, exportDir, repo, state, run, reset, sectionsFile };
}

const ficheNodes = (repo, pageId) => repo.listByType('fiche').filter((n) => n.attrs.pageId === pageId && !n.attrs.retired);

describe('fiches dans la synchro Confluence', () => {
  test('ops page gets fiches after its reading', async () => {
    const { repo, state, run } = setup();
    const before = impactOf(repo, 'server:srvorh01').total;
    const r = await run();
    assert.equal(r.stats.errors, 0);
    assert.equal(r.stats.ficheErrors, 0);
    assert.equal(r.stats.fiches, 5);
    assert.deepEqual([...state.fiche].sort(), OPS_TITLES);

    const inc = repo.getNode('fiche:8001-1');
    assert.equal(inc.type, 'fiche');
    assert.equal(inc.name, 'Lenteur du portail');
    assert.equal(inc.attrs.kind, 'incident');
    assert.equal(inc.attrs.url, 'https://wiki.example.local/8001#lenteur'); // ancre de la section
    assert.equal(inc.attrs.pageId, '8001');
    assert.equal(inc.attrs.docId, 'document:confluence-8001');
    assert.equal(inc.attrs.period, 'current');
    assert.equal(inc.attrs.replacedBy, null);
    assert.deepEqual(inc.attrs.tickets, ['INC-100']);
    assert.equal(inc.attrs.fields.solution.text, 'redemarrer le service orderhub-web');
    // sans section reconnue dans la page : l'adresse de la page seule
    assert.equal(repo.getNode('fiche:8001-2').attrs.url, 'https://wiki.example.local/8001');

    const links = repo.edgesFrom('fiche:8001-1').map((e) => [e.type, e.dst, e.source, e.sourceRef]).sort();
    assert.deepEqual(links, [
      ['concerne', 'application:orderhub', 'knowledge', '8001'],
      ['concerne', 'server:srvorh01', 'knowledge', '8001'],
      ['vient_de', 'document:confluence-8001', 'knowledge', '8001'],
    ]);

    const doc = repo.getDocument('confluence:8001');
    assert.equal(doc.status, 'enriched');
    assert.ok(doc.attrs.opsHash);
    assert.equal(doc.attrs.opsContentHash, doc.attrs.readingContentHash);
    assert.equal(doc.attrs.ficheCount, 2);
    assert.ok(doc.attrs.reading); // la lecture de la page est gardée
    assert.equal(impactOf(repo, 'server:srvorh01').total, before); // les fiches ne changent pas l'impact
    assert.ok(!impactOf(repo, 'server:srvorh01').items.some((i) => i.type === 'fiche'));
  });

  test('non ops page gets none', async () => {
    const { repo, state, run } = setup();
    await run();
    assert.ok(!state.fiche.includes(T_MEET));
    assert.equal(ficheNodes(repo, '8005').length, 0);
    assert.equal(repo.getDocument('confluence:8005').attrs.ficheCount, undefined);
    assert.equal(repo.getDocument('confluence:8005').attrs.opsHash, undefined);
  });

  test('fiche failure keeps the page reading and counts an error', async () => {
    const warns = [];
    const { repo, state, run, reset } = setup([T_INC, T_MEET]);
    state.failFiches = true;
    const r = await run({ log: { ...silent, warn: (m) => warns.push(m) } });
    assert.equal(r.stats.ficheErrors, 1);
    assert.equal(r.stats.errors, 0);
    assert.equal(r.stats.fiches, 0);
    assert.equal(r.stats.read, 2);
    const doc = repo.getDocument('confluence:8001');
    assert.equal(doc.status, 'enriched'); // la page n'est pas en erreur
    assert.ok(doc.attrs.reading);
    assert.equal(doc.attrs.opsHash, undefined); // empreinte non mise à jour : reprise au passage suivant
    assert.equal(repo.getNode('document:confluence-8001').attrs.pageKindAi, 'incident');
    const errs = repo.errorsOfRun(r.runId);
    assert.deepEqual(errs.map((e) => [e.source, e.ref, e.step]), [['confluence', '8001', 'fiches']]);
    assert.ok(warns.some((m) => /8001/.test(m) && /fiches/.test(m)));
    // ni le secret du message d'erreur ni le contenu de la page ne sont écrits
    assert.ok(![...warns, ...errs.map((e) => e.message)].some((m) => /Azerty12/.test(m) || /redemarrer le service/.test(m)));

    // passage suivant : seules les fiches sont reprises
    state.failFiches = false;
    reset();
    const r2 = await run();
    assert.deepEqual(state.reading, []);
    assert.deepEqual(state.fiche, [T_INC]);
    assert.equal(r2.stats.fiches, 2);
    assert.equal(r2.stats.ficheErrors, 0);
    assert.equal(repo.getDocument('confluence:8001').attrs.ficheCount, 2);
  });

  test('second pass without change makes no AI call', async () => {
    const { run, state, reset } = setup();
    await run();
    reset();
    const r = await run();
    assert.deepEqual(state.reading, []);
    assert.deepEqual(state.fiche, []);
    assert.equal(r.stats.skipped, 5);
    assert.equal(r.stats.fiches, 0);
  });

  test('consignes change re-reads fiches only when the page reading is current', async () => {
    const { repo, run, state, reset } = setup();
    await run();
    // fiches seules : l'empreinte des fiches est périmée (ex. nouvelle version des consignes de fiches), pas celle de la lecture
    for (const id of ['8001', '8002', '8003', '8004']) {
      const d = repo.getDocument(`confluence:${id}`);
      repo.saveDocument({ id: d.id, source: d.source, title: d.title, url: d.url, version: d.version, updatedAt: d.updated_at, contentHash: d.content_hash, status: d.status, error: d.error, attrs: { ...d.attrs, opsHash: 'ancienne' } });
    }
    reset();
    const r = await run();
    assert.deepEqual(state.reading, []);
    assert.deepEqual([...state.fiche].sort(), OPS_TITLES);
    assert.equal(r.stats.read, 0);
    assert.equal(r.stats.fiches, 5);
    assert.notEqual(repo.getDocument('confluence:8001').attrs.opsHash, 'ancienne');
    // autres consignes : la lecture des pages est relancée, puis les fiches des pages d'exploitation
    reset();
    await run({ consignes: { text: 'Autres consignes.', hash: 'c2' } });
    assert.equal(state.reading.length, 5);
    assert.deepEqual([...state.fiche].sort(), OPS_TITLES);
  });

  test('fewer fiches on re-read retires the extra ones', async () => {
    const { repo, run, state, exportDir } = setup([T_INC]);
    await run();
    assert.equal(ficheNodes(repo, '8001').length, 2);
    // la page change et l'IA ne rend plus qu'une fiche
    fs.writeFileSync(path.join(exportDir, 'ESP', '8001 - OrderHub  Incident lenteur', 'page.html'), `${HTML[T_INC]}<p>Mise a jour.</p>`);
    state.ficheAnswer = () => ({ fiches: [FICHES[T_INC][0]] });
    await run();
    const second = repo.getNode('fiche:8001-2');
    assert.equal(second.attrs.retired, true);
    assert.deepEqual(repo.edgesFrom('fiche:8001-2'), []);
    assert.equal(repo.getNode('fiche:8001-1').attrs.retired, undefined);
    assert.equal(ficheNodes(repo, '8001').length, 1);
    assert.equal(repo.getDocument('confluence:8001').attrs.ficheCount, 1);
    assert.ok(repo.edgesFrom('fiche:8001-1').length >= 3);
  });

  test('ticket shared links correctif to incident', async () => {
    const { repo, run } = setup();
    const r = await run();
    const link = repo.edgesFrom('fiche:8002-1').find((e) => e.type === 'corrige');
    assert.ok(link);
    assert.equal(link.dst, 'fiche:8001-1');
    assert.equal(r.stats.corrige, 1);
    // une relecture sans changement des liens ne les duplique pas
    await run({ force: true });
    assert.equal(repo.allEdges().filter((e) => e.type === 'corrige').length, 1);
  });

  test('replaces marks the older procedure', async () => {
    const { repo, run } = setup();
    const r = await run();
    const old = repo.getNode('fiche:8003-1');
    assert.equal(old.attrs.replacedBy, 'fiche:8004-1');
    assert.equal(old.attrs.replacedByEvidence, 'Cette procedure remplace Redemarrer OrderHub');
    assert.equal(repo.getNode('fiche:8004-1').attrs.replacedBy, null);
    assert.equal(r.stats.remplacees, 1);
  });

  test('knowledge sections file lists the read pages without struck text', async () => {
    const { run, sectionsFile } = setup();
    await run();
    const rows = JSON.parse(fs.readFileSync(sectionsFile, 'utf8'));
    assert.deepEqual([...new Set(rows.map((x) => x.pageId))].sort(), ['8001', '8002', '8003', '8004', '8005']);
    const lent = rows.find((x) => x.pageId === '8001' && x.section === 'Lenteur du portail');
    assert.equal(lent.title, T_INC);
    assert.equal(lent.url, 'https://wiki.example.local/8001#lenteur');
    assert.equal(lent.period, 'current');
    assert.match(lent.text, /portail OrderHub est tres lent/);
    assert.ok(!/Ancienne solution/.test(lent.text)); // texte barre exclu
    // page sautee au second passage : toujours dans le fichier, qui est reecrit
    fs.rmSync(sectionsFile);
    await run();
    assert.equal(JSON.parse(fs.readFileSync(sectionsFile, 'utf8')).filter((x) => x.pageId === '8003').length, 1);
  });

  test('no sections file without the option, and no fiche without AI', async () => {
    const { run, dir, repo } = setup();
    const r = await run({ knowledgeSectionsFile: null, llm: null });
    assert.equal(fs.existsSync(path.join(dir, 'data')), false);
    assert.equal(r.stats.fiches, 0);
    assert.equal(repo.listByType('fiche').length, 0);
  });
});

describe('fiches : corrections de revue', () => {
  test('a reading-made server cited only by a fiche is still retired', async () => {
    const { repo, run } = setup([T_INC]);
    await run();
    repo.upsertNode({ type: 'server', key: 'srvghost09', name: 'srvghost09', source: 'llm', attrs: { fromLlm: true, outOfInventory: true } });
    repo.addEdge({ src: 'fiche:8001-1', dst: 'server:srvghost09', type: 'concerne', source: 'knowledge', sourceRef: '8001' });
    const { retireOrphans } = require('../src/reading/syncPages');
    retireOrphans(repo, NOW);
    assert.equal(repo.getNode('server:srvghost09').attrs.retired, true);
  });

  test('forced re-read then fiche failure: the next pass retries the fiches', async () => {
    const { repo, run, state, reset } = setup([T_INC]);
    await run();
    assert.ok(repo.getDocument('confluence:8001').attrs.opsHash);
    state.failFiches = true;
    reset();
    const r = await run({ force: true });
    assert.equal(r.stats.ficheErrors, 1);
    assert.equal(repo.getDocument('confluence:8001').attrs.opsHash, undefined);
    state.failFiches = false;
    reset();
    await run();
    assert.deepEqual(state.reading, []);
    assert.deepEqual(state.fiche, [T_INC]);
    assert.ok(repo.getDocument('confluence:8001').attrs.opsHash);
  });

  test('a secret in a section is masked in the sections file', async () => {
    const { run, sectionsFile, exportDir } = setup([T_MEET]);
    fs.writeFileSync(path.join(exportDir, 'ESP', '8005 - CR reunion du 1211', 'page.html'), '<h2 id="acces">Acces</h2><p>Le compte : mot de passe : Azerty12 pour la recette.</p>');
    await run();
    const raw = fs.readFileSync(sectionsFile, 'utf8');
    assert.ok(!/Azerty12/.test(raw));
    assert.match(raw, /\[masqué\]/);
  });
});

describe('linkFiches', () => {
  test('replaces: ambiguous match, newer target and unique older match', () => {
    const repo = createRepo(openStore(':memory:'));
    repo.upsertNode({ type: 'application', key: 'a', name: 'A', source: 't' });
    const proc = (id, pageId, title, updatedAt, extra = {}) =>
      repo.upsertNode({ type: 'fiche', key: id, name: title, source: 'llm', attrs: { kind: 'procedure', title, pageId, url: `https://w.example.local/${pageId}`, updatedAt, replacedBy: null, tickets: [], fields: {}, lists: {}, replaces: null, fixes: null, ...extra } });
    const link = (id) => repo.addEdge({ src: `fiche:${id}`, dst: 'application:a', type: 'concerne', source: 'knowledge', sourceRef: id });
    // ambigu : deux anciennes procedures de meme titre sur la meme application
    proc('1-1', '1', 'Installer', '2024-01-01'); link('1-1');
    proc('2-1', '2', 'Installer', '2024-02-01'); link('2-1');
    proc('3-1', '3', 'Installer v3', '2026-01-01', { replaces: it0('Installer', 'remplace Installer') }); link('3-1');
    assert.equal(linkFiches(repo).remplacees, 0);
    assert.equal(repo.getNode('fiche:1-1').attrs.replacedBy, null);
    assert.equal(repo.getNode('fiche:2-1').attrs.replacedBy, null);
    // cible plus recente : rien, et pas de remplacement mutuel
    proc('4-1', '4', 'Sauvegarder', '2026-05-01', { replaces: it0('Restaurer', 'remplace Restaurer') }); link('4-1');
    proc('5-1', '5', 'Restaurer', '2026-06-01', { replaces: it0('Sauvegarder', 'remplace Sauvegarder') }); link('5-1');
    assert.equal(linkFiches(repo).remplacees, 1); // seule 5 remplace 4 (4 est plus ancienne)
    assert.equal(repo.getNode('fiche:5-1').attrs.replacedBy, null);
    assert.equal(repo.getNode('fiche:4-1').attrs.replacedBy, 'fiche:5-1');
    // cible plus recente seule
    proc('6-1', '6', 'Purger', '2027-01-01'); link('6-1');
    proc('7-1', '7', 'Purger v2', '2026-01-01', { replaces: it0('Purger', 'remplace Purger') }); link('7-1');
    linkFiches(repo);
    assert.equal(repo.getNode('fiche:6-1').attrs.replacedBy, null);
  });

  const mk = (repo, id, attrs) => repo.upsertNode({ type: 'fiche', key: id, name: attrs.title, source: 'llm', attrs: { replacedBy: null, tickets: [], fields: {}, lists: {}, replaces: null, fixes: null, ...attrs } });

  test('fixes names the incident title, and replaces resolves by the cited Confluence link first', () => {
    const repo = createRepo(openStore(':memory:'));
    repo.upsertNode({ type: 'application', key: 'a', name: 'A', source: 't' });
    mk(repo, '1-1', { kind: 'incident', title: 'Page blanche apres connexion', pageId: '1', url: 'https://w.example.local/1' });
    mk(repo, '2-1', { kind: 'correctif', title: 'Corrige', pageId: '2', url: 'https://w.example.local/2', fixes: it0('Incident : page blanche apres connexion') });
    mk(repo, '3-1', { kind: 'procedure', title: 'Installer', pageId: '3', url: 'https://w.example.local/3', updatedAt: '2025-01-01' });
    mk(repo, '3-2', { kind: 'procedure', title: 'Installer le client', pageId: '3', url: 'https://w.example.local/3', updatedAt: '2025-01-01' });
    mk(repo, '4-1', { kind: 'procedure', title: 'Installer v2', pageId: '4', url: 'https://w.example.local/4', updatedAt: '2026-01-01', replaces: it0('Installer le client', 'remplace https://w.example.local/3#installer') });
    const r = linkFiches(repo);
    assert.equal(r.corrige, 1);
    assert.equal(r.remplacees, 1);
    assert.ok(repo.edgesFrom('fiche:2-1').some((e) => e.type === 'corrige' && e.dst === 'fiche:1-1'));
    assert.equal(repo.getNode('fiche:3-2').attrs.replacedBy, 'fiche:4-1'); // le titre cite departage deux procedures de la meme page
    assert.equal(repo.getNode('fiche:3-1').attrs.replacedBy, null);
    // refait en entier : un retrait de la fiche ancienne efface le lien
    repo.patchNodeAttrs('fiche:1-1', { retired: true });
    assert.equal(linkFiches(repo).corrige, 0);
    assert.ok(!repo.edgesFrom('fiche:2-1').some((e) => e.type === 'corrige'));
  });
});
