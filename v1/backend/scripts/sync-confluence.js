#!/usr/bin/env node
'use strict';
/**
 * Traite les pages Confluence déjà exportées par le fetcher (Lyra n'appelle pas Confluence).
 *
 * Entrée (CONFLUENCE_EXPORT_DIR) : un dossier par page, à n'importe quelle profondeur
 *   <dossier>/metadata.json + page.html (+ page.storage.xml, images/, attachments/ optionnels)
 * Le format historique pages/*.json + attachments/<pageId>/ est toujours accepté.
 *
 * Usage :
 *   node scripts/sync-confluence.js            étape sans IA (structure, liens, draw.io)
 *   node scripts/sync-confluence.js --llm      + extraction des relations par IA
 *   node scripts/sync-confluence.js --force    retraite même les pages inchangées
 *   node scripts/sync-confluence.js --limit 20 ne traite que 20 pages (test)
 *   node scripts/sync-confluence.js --llm --no-triage  sans le tri IA des pages où aucun nom du périmètre n'est reconnu
 *
 * Avec un périmètre (config/perimeter.json) : chaque page est rattachée aux applications suivies
 * (nom, variante, faute, sigle, serveur connu…). Seules ces pages partent à l'IA, et les relations
 * vers des applications hors périmètre sont écartées. Rapports CSV dans data/rapports/.
 * Lancer l'import APM AVANT : il donne les serveurs de chaque application, qui servent d'indice.
 */
const fs = require('fs');
const config = require('../src/config');
const { openStore, acquireLock } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { ingestConfluencePage, documentId } = require('../src/ingest/confluence');
const { readExportPages, exportHash, analyseEntry, loadDiagrams } = require('../src/ingest/confluenceExport');
const { extractRelations, applyRelations, triagePage, chunkText } = require('../src/enrich/relations');
const { loadPerimeter, createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { architectureScore, auditArchitecturePage, DEFAULT_KEYWORDS } = require('../src/perimeter/architecture');
const { writeCsvReport } = require('../src/lib/report');
const { createLlmClient } = require('../src/lib/llmClient');
const { createLogger } = require('../src/lib/logger');

const log = createLogger('sync-confluence');
const args = process.argv.slice(2);
const opt = {
  llm: args.includes('--llm'),
  force: args.includes('--force'),
  triage: !args.includes('--no-triage'),
  limit: args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity,
};
const FLUSH_EVERY = 100; // sauvegarde régulière : une synchro interrompue garde ce qui est fait

/**
 * Envoie une page à l'IA.
 * Sans périmètre : toutes les sections. Avec périmètre : seulement si la page concerne une application suivie,
 * reconnue par les règles ou, à défaut, par un tri IA rapide (titre, pages parentes, début du texte).
 * @returns {Promise<Array<PromiseSettledResult>>}
 */
async function enrichPage({ llm, repo, page, p, nodeId, related, matcher, scope, counters, stats }) {
  let pageApps = related.map((x) => x.name);
  if (matcher && !pageApps.length) {
    if (!opt.triage) {
      stats.outOfScope++;
      return [];
    }
    const text = page.sections.map((s) => `${s.heading || ''}\n${s.text}`).join('\n');
    const ancestors = (p.ancestors || []).map((a) => (typeof a === 'string' ? a : a.title));
    let found;
    try {
      found = await triagePage(llm, { title: page.title, ancestors, text, scope });
    } catch (err) {
      return [{ status: 'rejected', reason: err }];
    }
    for (const f of found) {
      const m = matcher.resolveAppName(f.name);
      if (!m) continue;
      const confidence = +(0.6 * f.confidence + 0.1).toFixed(2); // tri IA : 0.46 à 0.7, sous les règles
      repo.addEdge({ src: m.app.id, dst: nodeId, type: 'documented_in', source: 'llm', sourceRef: p.id, confidence, attrs: { evidence: f.evidence } });
      if (!pageApps.includes(m.app.name)) pageApps.push(m.app.name);
    }
    if (!pageApps.length) {
      stats.outOfScope++;
      return [];
    }
    stats.triaged++;
  }
  const scoped = matcher ? { ...scope, pageApps, knownServers: knownServersOf(repo, page, matcher, pageApps) } : null;
  // toutes les sections partent en parallèle (la concurrence est limitée par le client LLM)
  const jobs = page.sections.flatMap((s) =>
    chunkText(s.text).map((text) =>
      extractRelations(llm, { pageTitle: page.title, section: { heading: s.heading, text }, hints: page.entities, scope: scoped }).then((res) => {
        return applyRelations(repo, res, { sourceRef: p.id, docId: nodeId, matcher, counters });
      })
    )
  );
  return Promise.allSettled(jobs);
}

/**
 * Rapports tirés du graphe (donc complets même quand les pages inchangées sont sautées) :
 *  - perimetre-pages.csv : pour chaque application, les pages qui la concernent, avec score et raisons
 *  - perimetre-orthographes.csv : les façons dont chaque application est écrite, à valider en alias
 */
function writePerimeterReports(repo, matcher) {
  const rows = [];
  const spellings = new Map();
  for (const app of matcher.apps) {
    for (const e of repo.edgesFrom(app.id).filter((x) => x.type === 'documented_in')) {
      const doc = repo.getNode(e.dst);
      if (!doc) continue;
      const how = e.source === 'llm' ? 'tri IA' : 'règles';
      rows.push([app.name, doc.name, doc.attrs.url || '', e.confidence, e.attrs.reasons || [e.attrs.evidence || ''], e.attrs.spellings || [], how]);
      for (const sp of e.attrs.spellings || []) {
        const k = `${app.name}|${sp}`;
        spellings.set(k, (spellings.get(k) || 0) + 1);
      }
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b[3] - a[3]));
  const f1 = writeCsvReport(config.reportsDir, 'perimetre-pages', ['application', 'page', 'url', 'score', 'raisons', 'orthographes à vérifier', 'trouvé par'], rows);
  const f2 = writeCsvReport(
    config.reportsDir,
    'perimetre-orthographes',
    ['application', 'écrit dans Confluence', 'nombre de pages', 'action'],
    [...spellings.entries()]
      .map(([k, n]) => [...k.split('|'), n, "si c'est bien elle : l'ajouter en alias dans config/perimeter.json ; sinon le signaler"])
      .sort((a, b) => b[2] - a[2])
  );
  const f3 = writeArchitectureReports(repo, matcher);
  log.info(`rapports : ${f1} ; ${f2} ; ${f3.join(' ; ')}`);
}

/**
 * Contrôle des pages d'architecture :
 *  - architecture-pages.csv : une ligne par page et application (serveurs confirmés, manquants, inconnus, IP, rubriques)
 *  - architecture-applications.csv : par application, serveurs documentés dans AUCUNE page d'architecture
 */
function writeArchitectureReports(repo, matcher) {
  const rows = [];
  const summary = [];
  for (const app of matcher.apps) {
    const documented = new Set();
    let pages = 0;
    let best = null;
    for (const e of repo.edgesFrom(app.id).filter((x) => x.type === 'documented_in' && x.attrs.audit)) {
      const doc = repo.getNode(e.dst);
      if (!doc) continue;
      const a = e.attrs.audit;
      pages++;
      for (const n of a.confirmed) documented.add(n.toLowerCase());
      if (a.completeness !== null && (best === null || a.completeness > best)) best = a.completeness;
      rows.push([
        app.name, doc.name, doc.attrs.url || '', doc.attrs.updatedAt || '', a.environment || '',
        a.completeness === null ? '' : `${Math.round(a.completeness * 100)} %`,
        a.confirmed, a.missing, a.otherApp, a.unknown, a.ipMismatch, a.absentSections, a.verdict,
      ]);
    }
    const never = [...app.servers].map((id) => repo.getNode(id)?.name).filter((n) => n && !documented.has(n.toLowerCase()));
    summary.push([app.name, pages, best === null ? '' : `${Math.round(best * 100)} %`, app.servers.size, never, pages ? '' : "aucune page d'architecture trouvée"]);
  }
  return [
    writeCsvReport(
      config.reportsDir,
      'architecture-pages',
      ['application', 'page', 'url', 'modifiée le', 'environnement', 'complétude', 'serveurs confirmés', 'serveurs manquants', "serveurs d'une autre application", 'inconnus des inventaires', 'IP différentes', 'rubriques absentes', 'verdict'],
      rows
    ),
    writeCsvReport(config.reportsDir, 'architecture-applications', ['application', "pages d'architecture", 'meilleure complétude', 'serveurs (inventaires)', "serveurs documentés dans aucune page d'architecture", 'remarque'], summary),
  ];
}

/** Serveurs des applications de la page qui sont cités dans la page (indice pour l'IA). */
function knownServersOf(repo, page, matcher, pageApps) {
  const apps = matcher.apps.filter((a) => pageApps.includes(a.name));
  const text = [page.title, ...page.sections.map((s) => s.text)].join('\n');
  const cited = matcher.serversIn(text, [...page.entities.hosts, ...page.entities.ips]);
  return [...cited]
    .filter((sid) => apps.some((a) => a.servers.has(sid)))
    .map((sid) => repo.getNode(sid)?.name || sid)
    .slice(0, 30);
}

async function main() {
  const dir = config.confluence.exportDir;
  if (!fs.existsSync(dir)) {
    log.error(`Dossier d'export introuvable : ${dir} (CONFLUENCE_EXPORT_DIR dans backend/.env)`);
    process.exit(1);
  }
  const release = acquireLock(config.dataDir);
  const repo = createRepo(openStore(config.dataDir));
  const llm = opt.llm ? createLlmClient(config.llm) : null;
  const runId = repo.startRun(opt.llm ? 'confluence+llm' : 'confluence');
  const stats = { pages: 0, skipped: 0, errors: 0, mentions: 0, diagramLinks: 0, diagramsMissing: 0, obsoleteFragments: 0, llmRelations: 0, unresolved: 0 };
  const llmJobs = [];

  const perimeter = loadPerimeter(config.perimeterFile);
  let matcher = null;
  let scope = null;
  if (perimeter) {
    ensurePerimeterNodes(repo, perimeter);
    matcher = createMatcher(perimeter, repo);
    scope = { apps: perimeter.applications, ignoreOthers: perimeter.ignoreOtherApplications };
    Object.assign(stats, { inScope: 0, triaged: 0, outOfScope: 0, llmDropped: 0, llmRenamed: 0, architecturePages: 0 });
    const noServers = matcher.apps.filter((a) => !a.servers.size).map((a) => a.name);
    log.info(`périmètre : ${perimeter.applications.length} applications`);
    if (noServers.length) log.warn(`sans serveur connu (import APM fait ?) : ${noServers.join(', ')}`);
  }
  const counters = { dropped: 0, renamed: 0 };

  try {
    for (const entry of readExportPages(dir)) {
      if (stats.pages + stats.skipped >= opt.limit) break;
      if (entry.error) {
        stats.errors++;
        repo.recordError(runId, { source: 'confluence', ref: entry.ref, step: 'read', message: entry.error.message });
        log.warn(`${entry.ref} illisible : ${entry.error.message}`);
        continue;
      }
      const { p } = entry;
      const docId = `confluence:${p.id}`;
      const hash = exportHash(entry);
      const prev = repo.getDocument(docId);
      const unchanged = !opt.force && prev && prev.content_hash === hash && prev.status !== 'error' && (prev.attrs?.perimeterHash || null) === (matcher ? matcher.hash : null);
      // inventaires réimportés (serveurs des applications changés) : on refait les règles et les contrôles, pas l'IA
      const serversChanged = Boolean(matcher) && (prev?.attrs?.serversHash || null) !== matcher.serversHash;
      const needLlm = opt.llm && !(unchanged && prev.status === 'enriched');
      if (unchanged && !serversChanged && !needLlm) {
        stats.skipped++;
        continue;
      }
      const docBase = { attrs: {}, id: docId, source: 'confluence', title: p.title, url: p.url, version: p.version, updatedAt: p.updatedAt, contentHash: hash };
      try {
        const page = analyseEntry(entry);
        const diagrams = loadDiagrams(dir, entry, page);
        const docAttrs = { folder: entry.ref, parentId: p.parentId || null, ancestors: p.ancestors || [], images: entry.imageFiles.length, diagramsMissing: diagrams.missing };
        const r = ingestConfluencePage(repo, page, { drawioResults: diagrams.results, url: p.url, attrs: docAttrs });
        const nodeId = `document:${documentId(p.id)}`;
        // applications du périmètre reconnues par les règles (sans IA)
        const related = matcher ? matcher.scanPage({ ...page, ancestors: p.ancestors || page.ancestors || [] }).filter((x) => x.score >= 0.6) : [];
        if (matcher) {
          docBase.attrs = { perimeterHash: matcher.hash, serversHash: matcher.serversHash, perimeterApps: related.map((x) => ({ id: x.id, score: x.score })) };
          // page d'architecture : contrôlée par rapport aux inventaires pour chaque application concernée
          const archi = architectureScore(page, { keywords: perimeter.architectureKeywords || DEFAULT_KEYWORDS, ancestors: p.ancestors || [] });
          const isArchi = archi.score >= 0.6;
          if (isArchi) {
            stats.architecturePages++;
            repo.upsertNode({ type: 'document', key: documentId(p.id), name: page.title, source: 'confluence', attrs: { pageKind: 'architecture', architecture: archi } });
          }
          for (const x of related) {
            const audit = isArchi ? auditArchitecturePage(repo, matcher, { ...page, updatedAt: p.updatedAt || page.updatedAt }, x.id) : undefined;
            repo.addEdge({ src: x.id, dst: nodeId, type: 'documented_in', source: 'confluence', sourceRef: p.id, confidence: x.score, attrs: { reasons: x.reasons, spellings: x.spellings, audit } });
          }
          if (related.length) stats.inScope++;
        }
        stats.pages++;
        stats.mentions += r.mentions;
        stats.diagramLinks += r.diagramLinks;
        stats.diagramsMissing += diagrams.missing.length;
        stats.obsoleteFragments += page.obsoleteFragments || 0;
        stats.unresolved += r.unresolved.length;
        // page déjà enrichie dont seuls les inventaires ont changé : elle garde son statut, l'IA n'est pas relancée
        const keepStatus = !needLlm && prev && prev.status === 'enriched' && unchanged;
        repo.saveDocument({ ...docBase, status: keepStatus ? 'enriched' : 'parsed', attrs: { ...docBase.attrs, obsoleteFragments: page.obsoleteFragments || 0, sections: page.sections.length, tables: page.tables.length } });

        if (llm && needLlm) {
          llmJobs.push(
            enrichPage({ llm, repo, page, p, nodeId, related, matcher, scope, counters, stats }).then((results) => {
              const failures = results.filter((x) => x.status === 'rejected');
              stats.llmRelations += results.filter((x) => x.status === 'fulfilled').reduce((a, x) => a + x.value, 0);
              if (failures.length) {
                stats.errors++;
                const message = failures.map((f) => f.reason.message).join(' | ');
                repo.recordError(runId, { source: 'confluence', ref: p.id, step: 'llm', message });
                repo.saveDocument({ ...docBase, status: 'error', error: message });
              } else {
                repo.saveDocument({ ...docBase, status: 'enriched' });
              }
            })
          );
        }
      } catch (err) {
        stats.errors++;
        repo.recordError(runId, { source: 'confluence', ref: p.id || entry.ref, step: 'parse', message: err.message });
        repo.saveDocument({ ...docBase, status: 'error', error: err.message });
        log.warn(`page ${p.id} (${p.title}) en erreur : ${err.message}`);
      }
      const done = stats.pages + stats.skipped;
      if (done % FLUSH_EVERY === 0) {
        repo.flush();
        log.info('progression', stats);
      }
    }

    await Promise.all(llmJobs);
    if (matcher) {
      stats.llmDropped = counters.dropped;
      stats.llmRenamed = counters.renamed;
      writePerimeterReports(repo, matcher);
      const pagesOf = (a) => new Set(repo.edgesFrom(a.id).filter((e) => e.type === 'documented_in').map((e) => e.dst)).size;
      log.info('pages par application du périmètre', Object.fromEntries(matcher.apps.map((a) => [a.name, pagesOf(a)])));
    }
    const status = stats.errors ? 'partial' : 'success';
    repo.finishRun(runId, { status, stats: { ...stats, llm: llm ? llm.stats : undefined } });
    log.info(`terminé (${status})`, { ...stats, llm: llm ? llm.stats : undefined });
  } catch (err) {
    repo.finishRun(runId, { status: 'error', stats, error: err.message });
    throw err;
  } finally {
    repo.flush();
    release();
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
