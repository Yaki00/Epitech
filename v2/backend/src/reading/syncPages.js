'use strict';
/**
 * Analyse de l'export Confluence par lecture IA vérifiée (appelée par scripts/sync-confluence.js).
 *
 * Pour chaque page : lecture du format (sections, tableaux, schémas draw.io mis en texte), puis
 *  - lecture IA (readPage) si le contenu, la version de la lecture, les consignes ou le périmètre
 *    ont changé (empreinte `readingHash`), ou avec `force`, ou si elle a été lue une année précédente
 *    et que sa période (ou celle d'un de ses liens) est ancienne ou cible ;
 *  - sinon, si seuls les inventaires ou Naemon ont changé (empreinte `verifyHash`), la lecture
 *    gardée dans la ligne document (`attrs.reading`) est vérifiée et écrite de nouveau, sans IA ;
 *  - sinon la page est sautée.
 * Sans IA : la page est lue et stockée, rien n'est déduit (`stats.notRead`). Lecture en échec : la
 * page garde sa lecture précédente (rien n'est purgé) et passe en erreur, reprise au passage suivant.
 * En fin de passage, les pages vérifiées dont un lien est resté à valider, ou qui citent un serveur hors
 * inventaire, sont vérifiées et écrites une seconde fois, sans IA : la règle « base d'une autre
 * application », la corroboration par une autre page et le serveur dit arrêté ailleurs lisent le graphe,
 * qui est alors complet quel que soit l'ordre de lecture.
 * Fiches : une page dont la nature est « d'exploitation » (OPS_KINDS) reçoit, après sa lecture, un second appel
 * qui en tire des fiches vérifiées (src/knowledge). Leur empreinte (`opsHash`, `opsContentHash`) est propre : une page
 * dont la lecture est à jour mais pas les fiches ne relance que les fiches. Une fiche en échec n'arrête jamais le
 * passage et ne met jamais la page en erreur (`stats.ficheErrors`) : elle est reprise au passage suivant.
 * Après le passage, les nœuds créés par des lectures qui n'ont plus aucun lien actif sont marqués
 * retirés (jamais supprimés), sauf les personnes et équipes (anciens responsables montrés comme tels). Les rapports CSV sont tirés du graphe et des lignes document.
 */
const fs = require('fs');
const path = require('path');
const { sha256 } = require('../lib/hash');
const { writeCsvReport } = require('../lib/report');
const { readExportPages, exportHash, analyseEntry, loadDiagrams } = require('../ingest/confluenceExport');
const { ingestConfluencePage, documentId } = require('../ingest/confluence');
const { diagramsToText } = require('../parse/confluence/drawioText');
const { createMatcher, ensurePerimeterNodes, normalize } = require('../perimeter/perimeter');
const { SECTION_LABELS_FR } = require('../perimeter/architecture');
const { isInactiveEdge } = require('../graph/impact');
const { readPage, READING_VERSION } = require('./readPage');
const { pageHeaderLines } = require('./prompt');
const { verifyReading, DOC_SOURCES } = require('./verify');
const { applyReading, PAGE_SOURCES, INACTIVE_STATUS } = require('./apply');
const { OPS_KINDS, OPS_VERSION } = require('../knowledge/schema');
const { readFiches } = require('../knowledge/readFiches');
const { verifyFiches, SECRET } = require('../knowledge/verify');
const { applyFiches, linkFiches, ficheUrl } = require('../knowledge/apply');

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const OPS_KEYS = ['opsHash', 'opsContentHash', 'ficheCount'];
const READING_KEYS = ['reading', 'readingHash', 'readingContentHash', 'readingYear', 'verifyHash', 'rejected', 'rulesCleared', ...OPS_KEYS];
const STEP_FR = { llm: 'lecture IA', verify: 'vérification', apply: 'écriture dans le graphe', parse: 'analyse', fiches: 'fiches' };
const pickOps = (attrs) => Object.fromEntries(OPS_KEYS.filter((k) => attrs && attrs[k] !== undefined).map((k) => [k, attrs[k]]));

/** Empreinte de ce qui change la réponse de l'IA pour les fiches : version des fiches, consignes, périmètre. */
function opsHashOf({ consignes, matcher }) {
  return sha256([OPS_VERSION, (consignes && consignes.hash) || '', matcher ? matcher.hash : ''].join('|')).slice(0, 16);
}

/** Message d'une erreur du modèle pour le journal : sans mot de passe ni jeton, court (jamais le contenu d'une page). */
function safeMessage(err) {
  const g = new RegExp(SECRET.source, 'gi');
  return String((err && err.message) || err).replace(g, (m, k) => `${k} : [masqué]`).replace(/\s+/g, ' ').slice(0, 200);
}
const hasInventoryRow = (n) => Object.keys(n.attrs || {}).some((k) => k.endsWith('_row') && k !== 'confluence_row');

/** Empreinte de ce qui change la réponse de l'IA : version de la lecture, consignes, périmètre. */
function readingHashOf({ consignes, matcher }) {
  return sha256([READING_VERSION, (consignes && consignes.hash) || '', matcher ? matcher.hash : ''].join('|')).slice(0, 16);
}

/**
 * Empreinte de ce qui change la vérification sans changer la lecture : serveurs des inventaires
 * (nom, IP, FQDN), liens runs_on des inventaires, hôtes Naemon hors inventaire.
 * Seules les sources d'inventaire comptent : un lien ajouté par une lecture changerait l'empreinte
 * après chaque passage. Exception : les citations d'un serveur hors inventaire comme arrêté (une page
 * nouvelle ou modifiée qui dit un serveur arrêté fait revérifier les autres pages au passage suivant).
 * Le mois en cours (AAAA-MM) y entre aussi : la corroboration par une page modifiée depuis moins de
 * 24 mois est réévaluée chaque mois.
 */
function verifyHashOf(repo, naemonHosts, now = Date.now()) {
  const servers = repo
    .listByType('server')
    .filter((n) => !n.attrs.retired && !n.attrs.outOfInventory && hasInventoryRow(n))
    .map((n) => [n.id, n.attrs.ip || '', n.attrs.fqdn || '']);
  const links = repo
    .allEdges()
    .filter((e) => e.type === 'runs_on' && !DOC_SOURCES.has(e.source) && !e.attrs.retired)
    .map((e) => `${e.src}>${e.dst}`)
    .sort();
  const stopped = repo
    .allEdges()
    .filter((e) => e.type === 'mentions' && !e.attrs.retired && e.attrs.status === 'decommissioned')
    .filter((e) => {
      const n = repo.getNode(e.dst);
      return Boolean(n && n.type === 'server' && n.attrs.outOfInventory);
    })
    .map((e) => `${e.src}>${e.dst}:${e.attrs.period || ''}`)
    .sort();
  const month = new Date(now).toISOString().slice(0, 7);
  return sha256(JSON.stringify([servers, links, [...naemonHosts].sort(), month, stopped])).slice(0, 16);
}

/** Texte d'une page pour le résumé IA : titres et paragraphes, 4000 caractères au plus. */
function pageExcerpt(page) {
  return page.sections
    .map((s) => [s.heading, s.text].filter(Boolean).join('\n'))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 4000);
}

/** Date du jour (AAAA-MM-JJ) et année, en heure locale du serveur. */
function localDay(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return { today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, year: d.getFullYear() };
}

/**
 * Lecture qui dépend de l'année : page ou lien ancien ou cible. Lue une année précédente, elle est relue
 * (« Calendrier 2027 » lu cible en 2026 devient actuel en 2027) ; les autres pages ne le sont pas.
 */
function readingDependsOnYear(reading) {
  const timed = (p) => p === 'past' || p === 'target';
  return Boolean(reading && ((reading.page && timed(reading.page.period)) || (reading.links || []).some((l) => timed(l.period))));
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
 * @param {string|null} [o.knowledgeSectionsFile] fichier des sections de toutes les pages (recherche de second recours), réécrit à chaque passage (null : pas écrit)
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
  knowledgeSectionsFile = null,
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
    evidenceMismatch: 0,
    architecturePages: 0,
    diagramsMissing: 0,
    obsoleteFragments: 0,
    retired: 0,
    fiches: 0,
    ficheErrors: 0,
    ficheRejected: 0,
    corrige: 0,
    remplacees: 0,
  };
  if (matcher) stats.inScope = 0;
  const naemon = new Set((naemonHosts || []).map((h) => String(h).toLowerCase()));
  const readingHash = readingHashOf({ consignes, matcher });
  const verifyHash = verifyHashOf(repo, naemon, now);
  const opsHash = opsHashOf({ consignes, matcher });
  const apps = perimeter ? perimeter.applications.map((a) => ({ name: a.name, aliases: a.aliases })) : [];
  const perimeterIds = new Set(matcher ? matcher.apps.map((a) => a.id) : []);
  // date du jour donnée à l'IA pour juger la période des pages (« Plan 2026 » est actuel en 2026), heure locale
  const { today, year } = localDay(now);
  /** Pages vérifiées pendant ce passage dont un lien est resté à valider : revues une fois en fin de passage. */
  const recheck = new Map();
  /** Pages vérifiées et écrites pendant ce passage (leur empreinte est mise à jour en fin de passage). */
  const verifiedNow = new Set();
  /** Sections de toutes les pages lues (fichier de la recherche de second recours). */
  const sectionRows = [];

  /** Ajoute (sign 1) ou retire (sign -1) aux compteurs ce qu'une page a produit. */
  function count(res, sign) {
    const { out, verified } = res;
    for (const k of ['mentions', 'links', 'owners', 'toValidate', 'otherApp', 'rejected']) stats[k] += sign * (out[k] || 0);
    stats.evidenceMismatch += sign * verified.rejected.filter((r) => r.reason === 'evidence_mismatch').length;
    if (verified.kind === 'architecture') stats.architecturePages += sign;
    if (matcher && verified.apps.some((a) => perimeterIds.has(a.appId))) stats.inScope += sign;
  }

  /** Vérifie une lecture, l'écrit dans le graphe et enregistre la ligne document. Rend { out, verified }. */
  function verifyAndWrite(ctx, reading, readingAttrs) {
    const { page, p, docNodeId, docBase, rowAttrs } = ctx;
    let verified;
    try {
      verified = verifyReading(reading, {
        pageText: ctx.pageText,
        headerText: ctx.headerText,
        diagramsText: ctx.diagramsText,
        docNodeId,
        repo,
        matcher,
        naemonHosts: naemon,
        pageUpdatedAt: p.updatedAt || null,
        now,
      });
    } catch (err) {
      err.step = 'verify';
      throw err;
    }
    let out;
    try {
      out = applyReading(repo, verified, { pageId: p.id, docNodeId, page: { ...page, updatedAt: p.updatedAt || page.updatedAt }, matcher, now });
    } catch (err) {
      err.step = 'apply';
      throw err;
    }
    // texte gardé pour le résumé IA : seulement si la page porte sur une application
    const subject = verified.apps.some((a) => a.role === 'subject');
    repo.patchNodeAttrs(docNodeId, { excerpt: subject ? pageExcerpt(page) : undefined });
    repo.saveDocument({ ...docBase, status: 'enriched', attrs: { ...rowAttrs, ...(ctx.ops || {}), ...readingAttrs, reading, verifyHash, rejected: verified.rejected } });
    verifiedNow.add(docBase.id);
    return { out, verified };
  }

  function applyAndSave(ctx, reading, readingAttrs) {
    const res = verifyAndWrite(ctx, reading, readingAttrs);
    count(res, 1);
    // un lien à valider, ou un serveur hors inventaire, dépend du graphe (base d'une autre application,
    // serveur cité actif ou arrêté ailleurs) : la page est revue en fin de passage, quand toutes les pages sont écrites
    if (res.verified.links.some((l) => l.trust === 'toValidate') || res.verified.servers.some((s) => !s.inInventory)) recheck.set(ctx.p.id, { ctx, reading, readingAttrs, res });
    else recheck.delete(ctx.p.id);
    return res.verified;
  }

  /** Écrit les empreintes des fiches dans la ligne document (les autres attributs ne changent pas). */
  function saveOps(ctx) {
    const d = repo.getDocument(ctx.docBase.id);
    if (!d) return;
    const attrs = Object.fromEntries(Object.entries(d.attrs || {}).filter(([k]) => !OPS_KEYS.includes(k)));
    const { source, title, url, version, updated_at: updatedAt, content_hash: contentHash, status, error } = d;
    repo.saveDocument({ id: d.id, source, title, url, version, updatedAt, contentHash, status, error, attrs: { ...attrs, ...ctx.ops } });
  }

  /**
   * Fiches d'une page dont la lecture est écrite : lecture IA, vérification, écriture. Une page qui n'est plus
   * d'exploitation perd ses fiches. Ne lève jamais : en échec, l'empreinte reste ancienne (reprise au passage suivant).
   */
  async function ficheStep(ctx, kind) {
    if (!llm) return;
    const { p, page, docNodeId, docBase } = ctx;
    try {
      const node = repo.getNode(docNodeId);
      const pageInfo = { title: page.title || p.title, url: p.url, updatedAt: p.updatedAt || page.updatedAt, sections: page.sections };
      const period = node && node.attrs.period;
      if (!OPS_KINDS.includes(kind)) {
        applyFiches(repo, [], { pageId: p.id, docNodeId, page: pageInfo, period });
        ctx.ops = {};
      } else {
        const reading = await readFiches(
          llm,
          { title: pageInfo.title, ancestors: p.ancestors || [], today, kind, sections: page.sections, apps, consignes },
          { chunkChars, maxTokens }
        );
        const verified = verifyFiches(reading, { pageText: ctx.pageText, repo, matcher });
        const res = applyFiches(repo, verified, { pageId: p.id, docNodeId, page: pageInfo, period });
        stats.fiches += res.fiches.length;
        stats.ficheRejected += verified.rejected.length;
        ctx.ops = { opsHash, opsContentHash: docBase.contentHash, ficheCount: res.fiches.length };
      }
      saveOps(ctx);
    } catch (err) {
      stats.ficheErrors++;
      const message = safeMessage(err);
      log.warn(`page ${p.id} (${p.title}) : fiches en échec, page gardée, reprise au passage suivant : ${message}`);
      try {
        repo.recordError(runId, { source: 'confluence', ref: p.id, step: 'fiches', message });
      } catch (err2) {
        log.error(`page ${p.id} : erreur des fiches non enregistrée : ${err2.message}`);
      }
    }
  }

  /** Sections d'une page pour le fichier de recherche (texte barré déjà exclu par l'analyse de la page). */
  function collectSections(p, page, docNodeId) {
    if (!knowledgeSectionsFile) return;
    const title = page.title || p.title;
    for (const s of page.sections || []) {
      sectionRows.push({ pageId: String(p.id), docNodeId, title, url: ficheUrl({ url: p.url, sections: page.sections }, s.heading), section: s.heading || null, text: s.text });
    }
  }
  /** Page sautée : analysée seulement pour ses sections. */
  function collectSkipped(entry) {
    if (!knowledgeSectionsFile) return;
    try {
      collectSections(entry.p, analyseEntry(entry), `document:${documentId(entry.p.id)}`);
    } catch (err) {
      log.warn(`page ${entry.p.id} : sections non relevées : ${err.message}`);
    }
  }

  function writeSections() {
    if (!knowledgeSectionsFile) return;
    try {
      const rows = sectionRows.map(({ docNodeId, ...r }) => {
        const n = repo.getNode(docNodeId);
        return { ...r, period: (n && n.attrs.period) || null };
      });
      fs.mkdirSync(path.dirname(knowledgeSectionsFile), { recursive: true });
      const tmp = `${knowledgeSectionsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows));
      fs.renameSync(tmp, knowledgeSectionsFile);
    } catch (err) {
      log.warn(`sections de recherche non écrites : ${err.message}`);
    }
  }

  /** Un seul tour, sans IA : les liens uses_db et mentions lus par ces règles ne dépendent pas du graphe. */
  function recheckPages() {
    for (const { ctx, reading, readingAttrs, res } of recheck.values()) {
      try {
        const again = verifyAndWrite(ctx, reading, readingAttrs);
        count(res, -1);
        count(again, 1);
      } catch (err) {
        count(res, -1);
        fail(ctx, { ...readingAttrs, reading }, err.step || 'apply', err);
      }
    }
    recheck.clear();
  }

  /**
   * Les citations « serveur arrêté » écrites pendant ce passage changent l'empreinte : les pages vérifiées
   * pendant ce passage l'ont été sur le graphe complet (revue de fin de passage) et prennent l'empreinte de
   * fin ; les autres gardent l'ancienne et sont revérifiées, sans IA, au passage suivant.
   */
  function markVerifiedWithEndHash() {
    const endHash = verifyHashOf(repo, naemon, now);
    if (endHash === verifyHash) return;
    for (const id of verifiedNow) {
      const d = repo.getDocument(id);
      if (!d || d.status !== 'enriched' || !d.attrs || d.attrs.verifyHash !== verifyHash) continue;
      const { source, title, url, version, updated_at: updatedAt, content_hash: contentHash, status, error } = d;
      repo.saveDocument({ id, source, title, url, version, updatedAt, contentHash, status, error, attrs: { ...d.attrs, verifyHash: endHash } });
    }
  }

  /**
   * Page en erreur : erreur enregistrée avec son étape, ligne document qui garde la lecture précédente
   * (reprise au passage suivant). Ne lève jamais : un échec ici ne doit pas arrêter le passage.
   */
  function fail(ctx, prevAttrs, step, err) {
    const { p, docBase, rowAttrs } = ctx;
    stats.errors++;
    // une écriture en échec a pu purger une partie des liens de la page : on ne dit pas qu'ils sont gardés
    const outcome = step === 'apply' ? 'liens de la page peut-être retirés en partie, réécrits au passage suivant' : 'lecture précédente gardée';
    log.warn(`page ${p.id} (${p.title}) : ${STEP_FR[step] || step} en échec, ${outcome} : ${err.message}`);
    try {
      repo.recordError(runId, { source: 'confluence', ref: p.id, step, message: err.message });
      repo.saveDocument({ ...docBase, status: 'error', error: err.message, attrs: { ...(rowAttrs || {}), ...keepReading(prevAttrs) } });
    } catch (err2) {
      log.error(`page ${p.id} : erreur non enregistrée : ${err2.message}`);
    }
  }

  async function readAndApply(ctx, prevAttrs) {
    const { page, p, docBase } = ctx;
    let reading;
    let verified;
    try {
      reading = await readPage(
        llm,
        { title: page.title || p.title, ancestors: p.ancestors || [], space: p.spaceKey, updatedAt: p.updatedAt, today, sections: page.sections, diagramsText: ctx.diagramsText, apps, consignes },
        { chunkChars, maxTokens }
      );
    } catch (err) {
      fail(ctx, prevAttrs, 'llm', err);
      return;
    }
    try {
      verified = applyAndSave(ctx, reading, { readingHash, readingContentHash: docBase.contentHash, readingYear: year });
      stats.read++;
    } catch (err) {
      fail(ctx, prevAttrs, err.step || 'apply', err);
      return;
    }
    await ficheStep(ctx, verified.kind);
  }

  /** Sans IA, page jamais lue : ce que l'ancienne analyse (règles) avait écrit pour elle est retiré une fois. */
  function clearOldRules(ctx) {
    repo.removeEdgesBySourceRef(ctx.p.id, { sources: PAGE_SOURCES });
    repo.patchNodeAttrs(ctx.docNodeId, { pageKind: undefined, architecture: undefined, excerpt: undefined });
  }

  const inflight = new Set();
  const track = (promise) => {
    const q = promise.catch((err) => log.error(`erreur inattendue : ${err.message}`)).finally(() => inflight.delete(q));
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
      // lecture d'une année précédente qui dépend de l'année (page ou lien ancien ou cible) : relue
      const yearChanged = Boolean(pa.readingYear) && pa.readingYear !== year && readingDependsOnYear(pa.reading);
      const readingCurrent = !force && Boolean(pa.reading) && pa.readingContentHash === hash && pa.readingHash === readingHash && !yearChanged;
      const retry = prev && prev.status === 'error';

      // fiches à refaire seules : lecture à jour, page d'exploitation, empreinte des fiches périmée
      const node = repo.getNode(`document:${documentId(p.id)}`);
      const storedKind = node && node.attrs.pageKindAi;
      const opsStale = Boolean(llm) && readingCurrent && OPS_KINDS.includes(storedKind) && (pa.opsHash !== opsHash || pa.opsContentHash !== hash);

      if (readingCurrent && pa.verifyHash === verifyHash && contentSame && !retry && !opsStale) {
        stats.skipped++;
        collectSkipped(entry);
        continue;
      }
      if (!readingCurrent && !llm) {
        // page sans lecture à jour et sans IA : comptée « non lue » (jamais aussi « inchangée »)
        stats.notRead++;
        if (contentSame && prev.status === 'parsed' && (pa.reading || pa.rulesCleared)) {
          collectSkipped(entry);
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
          ops: pickOps(pa),
          // en-tête seul : l'environnement d'une page n'est retenu que s'il y est écrit (titre, pages parentes)
          headerText: pageHeaderLines({ title: page.title || p.title, ancestors: p.ancestors || [] }).join('\n'),
          // en-tête tel qu'envoyé à l'IA (« Titre : X », pages parentes), puis le texte : une citation de l'en-tête est retrouvée
          pageText: [...pageHeaderLines({ title: page.title || p.title, ancestors: p.ancestors || [] }), page.title || p.title, page.text || page.sections.map((s) => `${s.heading || ''}\n${s.text}`).join('\n')].join('\n'),
          diagramsText: diagramsToText(diagrams.results),
        };
        stats.pages++;
        stats.diagramsMissing += diagrams.missing.length;
        stats.obsoleteFragments += page.obsoleteFragments || 0;
        collectSections(p, page, ctx.docNodeId);

        if (readingCurrent) {
          // seuls les inventaires ou Naemon ont changé : vérification et écriture refaites sans IA
          if (pa.verifyHash === verifyHash && contentSame && !retry) {
            // rien d'autre n'a changé : seules les fiches sont refaites
            if (inflight.size >= maxInFlight) await Promise.race(inflight);
            track(ficheStep(ctx, storedKind));
          } else {
            const verified = applyAndSave(ctx, pa.reading, { readingHash: pa.readingHash, readingContentHash: pa.readingContentHash, readingYear: pa.readingYear });
            stats.reverified++;
            if (opsStale) {
              if (inflight.size >= maxInFlight) await Promise.race(inflight);
              track(ficheStep(ctx, verified.kind));
            }
          }
        } else if (!llm) {
          if (!pa.reading && !pa.rulesCleared) clearOldRules(ctx);
          repo.saveDocument({ ...docBase, status: 'parsed', attrs: { ...rowAttrs, ...keepReading(pa), ...(pa.reading ? {} : { rulesCleared: true }) } });
        } else {
          if (inflight.size >= maxInFlight) await Promise.race(inflight);
          track(readAndApply(ctx, pa));
        }
      } catch (err) {
        fail(ctx || { p, docBase }, pa, err.step || 'parse', err);
      }
      if (seen % flushEvery === 0) {
        repo.flush();
        log.info('progression', stats);
      }
    }
    await Promise.all(inflight);
    recheckPages();
    markVerifiedWithEndHash();
    ({ corrige: stats.corrige, remplacees: stats.remplacees } = linkFiches(repo));
    writeSections();

    stats.retired = retireOrphans(repo, now);
    const reports = reportsDir ? writeReports(repo, matcher, reportsDir) : [];
    if (reports.length) log.info(`rapports : ${reports.join(' ; ')}`);
    if (!llm && stats.notRead) log.warn(`${stats.notRead} pages non lues par l'IA (lancer avec --llm et une IA configurée) : rien n'en est déduit`);
    const status = stats.errors || stats.ficheErrors ? 'partial' : 'success';
    repo.finishRun(runId, { status, stats: { ...stats, llm: llm ? llm.stats : undefined } });
    return { runId, status, stats, reports };
  } catch (err) {
    await Promise.allSettled(inflight);
    repo.finishRun(runId, { status: 'error', stats, error: err.message });
    throw err;
  }
}

/**
 * Nœuds créés par des lectures (hors inventaire) sans aucun lien actif : retirés ; de nouveau liés : réactivés.
 * Un serveur seulement cité comme ancien, arrêté ou prévu (page ancienne ou cible, statut lu) est retiré.
 * Personnes et équipes exclues : citées dans une page ancienne, elles restent visibles comme anciens
 * responsables (leur lien owned_by porte la période).
 */
const NEVER_RETIRED = new Set(['person', 'team']);
/**
 * Une citation (lien mentions) garde un nœud actif seulement si la page est actuelle (ou de période
 * illisible) et que le serveur n'y est pas dit arrêté ou prévu : une page ancienne ne fait pas vivre un serveur.
 */
function mentionAlive(e) {
  const a = e.attrs || {};
  return !a.retired && !INACTIVE_STATUS.has(a.status) && a.period !== 'past' && a.period !== 'target';
}
function retireOrphans(repo, now) {
  const at = new Date(now).toISOString();
  let n = 0;
  for (const type of Object.keys(repo.countByType())) {
    if (NEVER_RETIRED.has(type)) continue;
    for (const node of repo.listByType(type)) {
      if (!node.attrs.fromLlm || hasInventoryRow(node)) continue;
      const active = [...repo.edgesFrom(node.id), ...repo.edgesTo(node.id)].some((e) => (e.type === 'mentions' ? mentionAlive(e) : !isInactiveEdge(e)));
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
const REASON_FR = {
  no_evidence: 'citation absente de la page',
  evidence_mismatch: "citation qui ne nomme pas l'élément",
  not_in_header: 'environnement absent du titre et des pages parentes',
  unknown_application: 'application inconnue',
  out_of_scope: 'hors périmètre ou introuvable',
};
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

module.exports = { runConfluenceSync, readingHashOf, opsHashOf, verifyHashOf, retireOrphans, pageExcerpt, localDay, readingDependsOnYear };
