'use strict';
/**
 * Lecture de l'export Confluence LOCAL (déjà récupéré par le fetcher, Lyra n'appelle pas Confluence).
 *
 * Format principal (un dossier par page, à n'importe quelle profondeur sous CONFLUENCE_EXPORT_DIR) :
 *   <dossier de la page>/
 *     metadata.json       pageId, title, url, spaceKey, version, updatedAt, parentId/ancestors, labels…
 *     page.html           HTML RENDU ("view")
 *     page.storage.xml    (optionnel) format storage : paramètres des macros (draw.io, Jira…)
 *     images/             (optionnel) images de la page
 *     attachments/        (optionnel) pièces jointes, dont les diagrammes .drawio
 *
 * Format historique (toujours accepté) : pages/*.json au format de l'API REST + attachments/<pageId>/.
 *
 * Règles :
 *  - la clé d'une page est metadata.pageId (le nom du dossier, "0006 - …", est un numéro d'ordre instable)
 *  - metadata.entities / metadata.keywords sont ignorés : Lyra recalcule les entités avec ses propres règles
 */
const fs = require('fs');
const path = require('path');
const { sha256 } = require('../lib/hash');
const { normalizeExportedPage } = require('./confluence');
const { parseStoragePage } = require('../parse/confluence/storage');
const { parseViewPage, mergeStorageMacros } = require('../parse/confluence/viewHtml');
const { parseDrawio } = require('../parse/confluence/drawio');

const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

/** Tous les dossiers de page (metadata.json + page.html), triés, à n'importe quelle profondeur. */
function findPageDirs(root) {
  const out = [];
  const walkDir = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (files.has('metadata.json') && files.has('page.html')) out.push(dir);
    if (depth >= 12) return;
    for (const e of entries) {
      if (e.isDirectory() && !['images', 'attachments', 'node_modules', '.git'].includes(e.name)) walkDir(path.join(dir, e.name), depth + 1);
    }
  };
  walkDir(root, 0);
  return out.sort();
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** Champs utiles de metadata.json, quelle que soit la variante du fetcher. */
function normalizeMetadata(meta) {
  const version = meta.version && typeof meta.version === 'object' ? meta.version.number : meta.version;
  const ancestors = asArray(meta.ancestors).map((a) => (typeof a === 'string' ? a : a.title || a.id)).filter(Boolean);
  return {
    id: String(meta.pageId ?? meta.id ?? ''),
    title: meta.title ?? meta.rawTitle ?? '',
    spaceKey: meta.spaceKey ?? (meta.space && meta.space.key) ?? '',
    // version 0 = non renseignée par le fetcher (une page Confluence commence à 1)
    version: Number(version) > 0 ? Number(version) : null,
    updatedAt: meta.updatedAt ?? meta.lastModified ?? null,
    createdAt: meta.createdAt ?? null,
    updatedBy: meta.updatedBy ?? null,
    status: meta.status ?? null,
    url: meta.url ?? null,
    parentId: meta.parentId != null ? String(meta.parentId) : null,
    ancestors,
    labels: asArray(meta.labels).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
  };
}

/**
 * Parcourt l'export et renvoie les pages, prêtes à analyser.
 * @returns {Generator<{p: object, html: string|null, storage: string|null, pageDir: string|null, ref: string, error?: Error}>}
 */
function* readExportPages(root) {
  const dirs = findPageDirs(root);
  if (dirs.length) {
    for (const dir of dirs) {
      const ref = path.relative(root, dir) || '.';
      try {
        const meta = normalizeMetadata(JSON.parse(readText(path.join(dir, 'metadata.json'))));
        if (!meta.id) throw new Error('metadata.json sans pageId');
        const html = readText(path.join(dir, 'page.html'));
        const storageFile = path.join(dir, 'page.storage.xml');
        const storage = fs.existsSync(storageFile) ? readText(storageFile) : null;
        const imagesDir = path.join(dir, 'images');
        const imageFiles = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).filter((f) => !f.startsWith('.')) : [];
        yield { p: { ...meta, storage }, html, storage, pageDir: dir, imageFiles, ref };
      } catch (error) {
        yield { p: null, html: null, storage: null, pageDir: dir, imageFiles: [], ref, error };
      }
    }
    return;
  }
  // format historique : pages/*.json
  const pagesDir = fs.existsSync(path.join(root, 'pages')) ? path.join(root, 'pages') : root;
  for (const f of fs.readdirSync(pagesDir).filter((x) => x.endsWith('.json')).sort()) {
    let data;
    try {
      data = JSON.parse(readText(path.join(pagesDir, f)));
    } catch (error) {
      yield { p: null, html: null, storage: null, pageDir: null, imageFiles: [], ref: f, error };
      continue;
    }
    for (const raw of Array.isArray(data) ? data : data.results || [data]) {
      const p = normalizeExportedPage(raw);
      yield { p, html: null, storage: p.storage, pageDir: null, imageFiles: [], ref: f };
    }
  }
}

/** Empreinte du contenu : une page inchangée n'est pas retraitée. */
const exportHash = ({ html, storage }) => sha256(`${html || ''}\n<!--storage-->\n${storage || ''}`);

/** Fichier d'un diagramme draw.io : <dossier page>/attachments/, <dossier page>/, ou attachments/<pageId>/ (historique). */
function findDiagramFile(root, entry, diagramName) {
  const bases = entry.pageDir ? [path.join(entry.pageDir, 'attachments'), entry.pageDir] : [path.join(root, 'attachments', String(entry.p.id))];
  for (const base of bases) {
    for (const n of [diagramName, `${diagramName}.drawio`, `${diagramName}.xml`]) {
      const file = path.join(base, n);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return null;
}

/** Analyse une page : rendu (page.html) si présent, sinon storage ; le storage complète les macros. */
function analyseEntry(entry) {
  const { p, html, storage } = entry;
  if (html !== null && html !== undefined) {
    const view = parseViewPage(html, p);
    return storage ? mergeStorageMacros(view, parseStoragePage(storage, p)) : view;
  }
  return parseStoragePage(storage || '', p);
}

/** Diagrammes draw.io de la page : ceux trouvés sont analysés, les autres sont listés dans `missing`. */
function loadDiagrams(root, entry, page) {
  const results = [];
  const missing = [];
  for (const d of page.diagrams.filter((x) => x.type === 'drawio' && x.name)) {
    const file = findDiagramFile(root, entry, d.name);
    if (file) results.push(parseDrawio(fs.readFileSync(file, 'utf8')));
    else missing.push(d.name);
  }
  return { results, missing };
}

module.exports = { findPageDirs, normalizeMetadata, readExportPages, exportHash, findDiagramFile, analyseEntry, loadDiagrams };
