'use strict';
/**
 * Analyse de l'export Confluence par lecture IA vérifiée (appelée par scripts/sync-confluence.js).
 *
 * Pour chaque page : lecture du format (sections, tableaux, schémas draw.io mis en texte), puis
 *  - lecture IA (readPage) si le contenu, la version de la lecture, les consignes ou le périmètre
 *    ont changé (empreinte `readingHash`), ou avec `force` ;
 *  - sinon, si seuls les inventaires ou Naemon ont changé (empreinte `verifyHash`), la lecture
 *    gardée dans la ligne document (`attrs.reading`) est vérifiée et écrite de nouveau, sans IA ;
 *  - sinon la page est sautée.
 * Sans IA : la page est lue et stockée, rien n'est déduit (`stats.notRead`). Lecture en échec : la
 * page garde sa lecture précédente (rien n'est purgé) et passe en erreur, reprise au passage suivant.
 * Après le passage, les nœuds créés par des lectures qui n'ont plus aucun lien actif sont marqués
 * retirés (jamais supprimés). Les rapports CSV sont tirés du graphe et des lignes document.
 */
const { sha256 } = require('../lib/hash');
const { writeCsvReport } = require('../lib/report');
const { readExportPages, exportHash, analyseEntry, loadDiagrams } = require('../ingest/confluenceExport');
const { ingestConfluencePage, documentId } = require('../ingest/confluence');
const { diagramsToText } = require('../parse/confluence/drawioText');
const { createMatcher, ensurePerimeterNodes, normalize } = require('../perimeter/perimeter');
const { SECTION_LABELS_FR } = require('../perimeter/architecture');
const { isInactiveEdge } = require('../graph/impact');
const { readPage, READING_VERSION } = require('./readPage');
const { verifyReading, DOC_SOURCES } = require('./verify');
const { applyReading } = require('./apply');

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const READING_KEYS = ['reading', 'readingHash', 'readingContentHash', 'verifyHash', 'rejected'];
const hasInventoryRow = (n) => Object.keys(n.attrs || {}).some((k) => k.endsWith('_row') && k !== 'confluence_row');

/** Empreinte de ce qui change la réponse de l'IA : version de la lecture, consignes, périmètre. */
function readingHashOf({ consignes, matcher }) {
  return sha256([READING_VERSION, (consignes && consignes.hash) || '', matcher ? matcher.hash : ''].join('|')).slice(0, 16);
}

/**
 * Empreinte de ce qui change la vérification sans changer la lecture : serveurs des inventaires
 * (nom, IP, FQDN), liens runs_on des inventaires, hôtes Naemon hors inventaire.
 * (L'empreinte `serversHash` du matcher compte aussi les liens ajoutés par les lectures : elle
 * changerait après chaque lecture, d'où ce calcul sur les seules sources d'inventaire.)
 */
function verifyHashOf(repo, naemonHosts) {
  const servers = repo
    .listByType('server')
    .filter((n) => !n.attrs.retired && !n.attrs.outOfInventory && hasInventoryRow(n))
    .map((n) => [n.id, n.attrs.ip || '', n.attrs.fqdn || '']);
  const links = repo
    .allEdges()
    .filter((e) => e.type === 'runs_on' && !DOC_SOURCES.has(e.source) && !e.attrs.retired)
    .map((e) => `${e.src}>${e.dst}`)
    .sort();
  return sha256(JSON.stringify([servers, links, [...naemonHosts].sort()])).slice(0, 16);
}

/** Texte d'une page pour le résumé IA : titres et paragraphes, 4000 caractères au plus. */
function pageExcerpt(page) {
  return page.sections
    .map((s) => [s.heading, s.text].filter(Boolean).join('\n'))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 4000);
}

const keepReading = (attrs) => Object.fromEntries(READING_KEYS.filter((k) => attrs && attrs[k] !== undefined).map((k) => [k, attrs[k]]));

/**
 * @param {object} o
 * @param {object} o.repo
 * @param {string} o.exportDir
 * @param {object|null} [o.llm]          client createLlmClient ; null = pages stockées sans lecture
 * @param {object|null} [o.perimeter]    résultat de loadPerimeter
 * @param {{text, hash}} [o.consignes]   résultat de loadConsignes
 * @param {string[]} [o.naemonHosts]     hôtes Naemon hors inventaire (unmatchedHosts)
 * @param {string|null} [o.reportsDir]   dossier des rapports CSV (null : pas de rapport)
 * @returns {Promise<{runId, status, stats, reports: string[]}>}
 */
async function runConfluenceSync({
  repo,
  exportDir,
  llm = null,
  perimeter = null,
  consignes = { text: '', hash: null },
  naemonHosts = [],
  reportsDir = null,
  force = false,
  limit = Infinity,
  chunkChars = 12000,
  maxTokens = 4096,
  maxInFlight = 8,
  flushEvery = 100,
  now = Date.now(),
  log = QUIET,
}) {
  let matcher = null;
  if (perimeter) {
    ensurePerimeterNodes(repo, perimeter);
    matcher = createMatcher(perimeter, repo);
  }
  const runId = repo.startRun(llm ? 'confluence+llm' : 'confluence');
  const stats = {
    pages: 0,
    skipped: 0,
    read: 0,
    reverified: 0,
    notRead: 0,
    errors: 0,
    mentions: 0,
    links: 0,
    owners: 0,
    toValidate: 0,
    otherApp: 0,
    rejected: 0,
    architecturePages: 0,
    diagramsMissing: 0,
    obsoleteFragments: 0,
    retired: 0,
  };
  if (matcher) stats.inScope = 0;
  const naemon = new Set((naemonHosts || []).map((h) => String(h).toLowerCase()));
  const readingHash = readingHashOf({ consignes, matcher });
  const verifyHash = verifyHashOf(repo, naemon);
  const apps = perimeter ? perimeter.applications.map((a) => ({ name: a.name, aliases: a.aliases })) : [];
  const perimeterIds = new Set(matcher ? matcher.apps.map((a) => a.id) : []);

  /** Vérifie une lecture, l'écrit dans le graphe et enregistre la ligne document. */
  function applyAndSave(ctx, reading, readingAttrs) {
    const { page, p, docNodeId, docBase, rowAttrs } = ctx;
    const verified = verifyReading(reading, { pageText: ctx.pageText, diagramsText: ctx.diagramsText, repo, matcher, naemonHosts: naemon, pageUpdatedAt: p.updatedAt || null, now });
    const out = applyReading(repo, verified, { pageId: p.id, docNodeId, page: { ...page, updatedAt: p.updatedAt || page.updatedAt }, matcher, now });
    for (const k of ['mentions', 'links', 'owners', 'toValidate', 'otherApp', 'rejected']) stats[k] += out[k] || 0;
    if (verified.kind === 'architecture') stats.architecturePages++;
    if (matcher && verified.apps.some((a) => perimeterIds.has(a.appId))) stats.inScope++;
    // texte gardé pour le résumé IA : seulement si la page porte sur une application
    const subject = verified.apps.some((a) => a.role === 'subject');
    repo.patchNodeAttrs(docNodeId, { excerpt: subject ? pageExcerpt(page) : undefined });
    repo.saveDocument({ ...docBase, status: 'enriched', attrs: { ...rowAttrs, ...readingAttrs, reading, verifyHash, rejected: verified.rejected } });
  }

  async function readAndApply(ctx, prevAttrs) {
    const { page, p, docBase, rowAttrs } = ctx;
    try {
      const reading = await readPage(
        llm,
        { title: page.title || p.title, ancestors: p.ancestors || [], space: p.spaceKey, updatedAt: p.updatedAt, sections: page.sections, diagramsText: ctx.diagramsText, apps, consignes },
        { chunkChars, maxTokens }
      );
      applyAndSave(ctx, reading, { readingHash, readingContentHash: docBase.contentHash });
      stats.read++;
    } catch (err) {
      stats.errors++;
      repo.recordError(runId, { source: 'confluence', ref: p.id, step: 'llm', message: err.message });
      // la page garde sa lecture précédente (graphe et ligne document) : reprise au passage suivant
      repo.saveDocument({ ...docBase, status: 'error', error: err.message, attrs: { ...rowAttrs, ...keepReading(prevAttrs) } });
      log.warn(`page ${p.id} (${p.title}) : lecture IA en échec, lecture précédente gardée : ${err.message}`);
    }
  }

  const inflight = new Set();
  const track = (promise) => {
    const q = promise.finally(() => inflight.delete(q));
    inflight.add(q);
  };

  try {
    let seen = 0;
    for (const entry of readExportPages(exportDir)) {
      if (seen >= limit) break;
      if (entry.error) {
        stats.errors++;
        repo.recordError(runId, { source: 'confluence', ref: entry.ref, step: 'read', message: entry.error.message });
        log.warn(`${entry.ref} illisible : ${entry.error.message}`);
        continue;
      }
      seen++;
      const { p } = entry;
      const docId = `confluence:${p.id}`;
      const hash = exportHash(entry);
      const prev = repo.getDocument(docId);
      const pa = (prev && prev.attrs) || {};
      const contentSame = Boolean(prev && prev.content_hash === hash);
      const readingCurrent = !force && Boolean(pa.reading) && pa.readingContentHash === hash && pa.readingHash === readingHash;
      const retry = prev && prev.status === 'error';

      if (readingCurrent && pa.verifyHash === verifyHash && contentSame && !retry) {
        stats.skipped++;
        continue;
      }
      if (!readingCurrent && !llm) {
        stats.notRead++;
        if (contentSame && prev.status === 'parsed') {
          stats.skipped++;
          continue;
        }
      }

      const docBase = { id: docId, source: 'confluence', title: p.title, url: p.url, version: p.version, updatedAt: p.updatedAt, contentHash: hash };
      let ctx;
      try {
        const page = analyseEntry(entry);
        const diagrams = loadDiagrams(exportDir, entry, page);
        const docAttrs = { folder: entry.ref, parentId: p.parentId || null, ancestors: p.ancestors || [], images: entry.imageFiles.length, diagramsMissing: diagrams.missing };
        ingestConfluencePage(repo, page, { url: p.url, attrs: docAttrs });
        const rowAttrs = { obsoleteFragments: page.obsoleteFragments || 0, sections: page.sections.length, tables: page.tables.length, diagramsMissing: diagrams.missing.length };
        ctx = {
          page,
          p,
          docBase,
          rowAttrs,
          docNodeId: `document:${documentId(p.id)}`,
          pageText: [page.title || p.title, page.text || page.sections.map((s) => `${s.heading || ''}\n${s.text}`).join('\n')].join('\n'),
          diagramsText: diagramsToText(diagrams.results),
        };
        stats.pages++;
        stats.diagramsMissing += diagrams.missing.length;
        stats.obsoleteFragments += page.obsoleteFragments || 0;

        if (readingCurrent) {
          // seuls les inventaires ou Naemon ont changé : vérification et écriture refaites sans IA
          applyAndSave(ctx, pa.reading, { readingHash: pa.readingHash, readingContentHash: pa.readingContentHash });
          stats.reverified++;
        } else if (!llm) {
          repo.saveDocument({ ...docBase, status: 'parsed', attrs: { ...rowAttrs, ...keepReading(pa) } });
        } else {
          if (inflight.size >= maxInFlight) await Promise.race(inflight);
          track(readAndApply(ctx, pa));
        }
      } catch (err) {
        stats.errors++;
        repo.recordError(runId, { source: 'confluence', ref: p.id || entry.ref, step: 'parse', message: err.message });
        repo.saveDocument({ ...docBase, status: 'error', error: err.message, attrs: keepReading(pa) });
        log.warn(`page ${p.id} (${p.title}) en erreur : ${err.message}`);
      }
      if (seen % flushEvery === 0) {
        repo.flush();
        log.info('progression', stats);
      }
    }
    await Promise.all(inflight);

    stats.retired = retireOrphans(repo, now);
    const reports = reportsDir ? writeReports(repo, matcher, reportsDir) : [];
    if (reports.length) log.info(`rapports : ${reports.join(' ; ')}`);
    if (!llm && stats.notRead) log.warn(`${stats.notRead} pages non lues par l'IA (lancer avec --llm et une IA configurée) : rien n'en est déduit`);
    const status = stats.errors ? 'partial' : 'success';
    repo.finishRun(runId, { status, stats: { ...stats, llm: llm ? llm.stats : undefined } });
    return { runId, status, stats, reports };
  } catch (err) {
    await Promise.allSettled(inflight);
    repo.finishRun(runId, { status: 'error', stats, error: err.message });
    throw err;
  }
}

/** Nœuds créés par des lectures (hors inventaire) sans aucun lien actif : retirés ; de nouveau liés : réactivés. */
function retireOrphans(repo, now) {
  const at = new Date(now).toISOString();
  let n = 0;
  for (const type of Object.keys(repo.countByType())) {
    for (const node of repo.listByType(type)) {
      if (!node.attrs.fromLlm || hasInventoryRow(node)) continue;
      const active = [...repo.edgesFrom(node.id), ...repo.edgesTo(node.id)].some((e) => !isInactiveEdge(e));
      if (!active && !node.attrs.retired) {
        repo.patchNodeAttrs(node.id, { retired: true, retiredAt: at });
        n++;
      } else if (active && node.attrs.retired) {
        repo.patchNodeAttrs(node.id, { retired: undefined, retiredAt: undefined });
      }
    }
  }
  return n;
}

// ---------- rapports ----------
const ROLE_FR = { subject: 'sujet', cited: 'citée' };
const REASON_FR = { no_evidence: 'citation absente de la page', unknown_application: 'application inconnue', out_of_scope: 'hors périmètre ou introuvable' };
const ENV_FR = { PRD: 'production (PRD)', STG: 'recette (STG)', DEV: 'développement (DEV)' };

function writeReports(repo, matcher, dir) {
  const files = [];
  if (matcher) files.push(...writePerimeterReports(repo, matcher, dir), ...writeArchitectureReports(repo, matcher, dir));
  files.push(writeRejectsReport(repo, dir));
  return files;
}

/**
 *  - perimetre-pages.csv : pour chaque application, les pages qui en parlent (rôle, citation)
 *  - perimetre-orthographes.csv : formes écrites dans les pages autres que le nom ou un alias déclaré
 */
function writePerimeterReports(repo, matcher, dir) {
  const rows = [];
  const spellings = new Map();
  for (const app of matcher.apps) {
    const known = new Set(app.variants.map((v) => v.norm));
    for (const e of repo.edgesFrom(app.id).filter((x) => x.type === 'documented_in')) {
      const doc = repo.getNode(e.dst);
      if (!doc) continue;
      rows.push([app.name, doc.name, doc.attrs.url || '', ROLE_FR[e.attrs.role] || '', e.attrs.evidence || '', e.attrs.written || '']);
      const w = String(e.attrs.written || '').trim();
      if (w && !known.has(normalize(w))) {
        const k = `${w}|${app.name}`;
        spellings.set(k, (spellings.get(k) || 0) + 1);
      }
    }
  }
  const rank = (r) => (r === 'sujet' ? 0 : 1);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : rank(a[3]) - rank(b[3]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  return [
    writeCsvReport(dir, 'perimetre-pages', ['application', 'page', 'url', 'rôle', 'citation', 'écrit dans la page'], rows),
    writeCsvReport(
      dir,
      'perimetre-orthographes',
      ['écrit dans Confluence', 'nom de référence', 'nombre de pages', 'action'],
      [...spellings.entries()]
        .map(([k, n]) => [...k.split('|'), n, "si c'est bien elle : l'ajouter en alias dans config/perimeter.json ; sinon le signaler"])
        .sort((a, b) => b[2] - a[2])
    ),
  ];
}

/**
 * Contrôle des pages d'architecture :
 *  - architecture-pages.csv : une ligne par page et application (serveurs confirmés, manquants, inconnus, IP, rubriques)
 *  - architecture-applications.csv : par application, serveurs documentés dans AUCUNE page d'architecture
 */
function writeArchitectureReports(repo, matcher, dir) {
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
        app.name,
        doc.name,
        doc.attrs.url || '',
        doc.attrs.updatedAt || '',
        ENV_FR[a.environment] || '',
        a.completeness === null ? '' : `${Math.round(a.completeness * 100)} %`,
        a.confirmed,
        a.missing,
        a.otherApp.map((o) => `${o.server} (${o.applications.join(', ')})`),
        a.unknown,
        a.ipMismatch.map((m) => `${m.server} : page ${m.page.join(', ')} / inventaire ${m.inventory.join(', ')}`),
        a.absentSections.map((k) => SECTION_LABELS_FR[k] || k),
        a.verdict,
      ]);
    }
    const never = [...app.servers].map((id) => repo.getNode(id)?.name).filter((n) => n && !documented.has(n.toLowerCase()));
    summary.push([app.name, pages, best === null ? '' : `${Math.round(best * 100)} %`, app.servers.size, never, pages ? '' : "aucune page d'architecture trouvée"]);
  }
  return [
    writeCsvReport(
      dir,
      'architecture-pages',
      ['application', 'page', 'url', 'modifiée le', 'environnement', 'complétude', 'serveurs confirmés', 'serveurs manquants', "serveurs d'une autre application", 'inconnus des inventaires', 'IP différentes', 'rubriques absentes', 'verdict'],
      rows
    ),
    writeCsvReport(dir, 'architecture-applications', ['application', "pages d'architecture", 'meilleure complétude', 'serveurs (inventaires)', "serveurs documentés dans aucune page d'architecture", 'remarque'], summary),
  ];
}

/** lectures-rejets.csv : éléments rendus par l'IA et écartés par la vérification (page, élément, raison). */
function writeRejectsReport(repo, dir) {
  const rows = [];
  for (const status of ['enriched', 'error', 'parsed']) {
    for (const d of repo.documentsByStatus(status)) {
      if (d.source !== 'confluence') continue;
      for (const r of (d.attrs && d.attrs.rejected) || []) rows.push([d.title || d.id, r.what, REASON_FR[r.reason] || r.reason, d.url || '']);
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return writeCsvReport(dir, 'lectures-rejets', ['page', 'élément', 'raison', 'url'], rows);
}

module.exports = { runConfluenceSync, readingHashOf, verifyHashOf, retireOrphans, pageExcerpt };
