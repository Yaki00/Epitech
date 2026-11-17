'use strict';
/**
 * Récupère les pages Confluence d'un ou plusieurs espaces dans CONFLUENCE_EXPORT_DIR, au format lu par Lyra :
 *
 *   <export>/<ESPACE>/<pageId> - <titre>/
 *     metadata.json       pageId, title, url, spaceKey, version, updatedAt, parentId, ancestors, labels, attachments
 *     page.html           rendu (body.view)
 *     page.storage.xml    format storage (macros draw.io, Jira…)
 *     images/<nom d'origine>        images jointes (le nom est celui cité dans le HTML)
 *     attachments/<nom du schéma>   schémas draw.io
 *
 * Incrémental : un fichier d'état (<export>/.fetch-state.json) garde la version de chaque page.
 * À chaque passage, on liste les pages (un appel pour 200 pages, version comprise) et on ne télécharge que
 * les pages nouvelles ou modifiées. Une page supprimée de Confluence est supprimée de l'export.
 * Sécurité : si un espace renvoie 0 page alors qu'on en connaissait, rien n'est supprimé (erreur probable).
 */
const fs = require('fs');
const path = require('path');
const { createLimiter } = require('../lib/limiter');

const STATE_FILE = '.fetch-state.json';
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|svg\+xml|bmp|webp)$/i;
const isDrawio = (a) => /jgraph|drawio|mxfile/i.test(a.mediaType || '') || /\.drawio$/i.test(a.title || '');

/** Nom de dossier ou de fichier valable sous Windows et Linux. */
function safeName(s, max = 80) {
  const clean = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const cut = clean.slice(0, max).replace(/[. ]+$/, '');
  return cut || '_';
}

// noms courts : les chemins Windows sont limités (260 caractères par défaut)
const pageFolder = (space, id, title) => path.join(safeName(space, 40), `${id} - ${safeName(title, 60)}`);

function readState(root) {
  const file = path.join(root, STATE_FILE);
  if (!fs.existsSync(file)) return { version: 1, pages: {}, spaces: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} illisible (${err.message}) : supprimez-le pour tout retélécharger`);
  }
}

function writeState(root, state) {
  const file = path.join(root, STATE_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Télécharge une page et ses pièces jointes utiles dans son dossier (remplacé en entier).
 * @returns {{attachments: number, skipped: string[]}}
 */
async function fetchPage(api, root, summary, { downloadImages = true, maxAttachmentBytes = 20 * 1024 * 1024 } = {}) {
  const page = await api.getPage(summary.id);
  const space = page.space?.key || summary.spaceKey;
  const folder = pageFolder(space, page.id, page.title);
  const dir = path.join(root, folder);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const attachments = [];
  const skipped = [];
  const list = await api.listAttachments(page.id);
  for (const a of list) {
    const mediaType = a.metadata?.mediaType || a.extensions?.mediaType || '';
    const size = Number(a.extensions?.fileSize) || 0;
    const kind = isDrawio({ ...a, mediaType }) ? 'drawio' : IMAGE_TYPES.test(mediaType) ? 'image' : null;
    if (!kind || (kind === 'image' && !downloadImages)) continue;
    if (size > maxAttachmentBytes) {
      skipped.push(`${a.title} (${Math.round(size / 1048576)} Mo)`);
      continue;
    }
    const rel = path.join(kind === 'drawio' ? 'attachments' : 'images', safeName(a.title, 100));
    writeFile(path.join(tmp, rel), await api.download(a._links.download));
    attachments.push({ id: a.id, title: a.title, mediaType, size, version: a.version?.number ?? null, file: rel.split(path.sep).join('/') });
  }

  const ancestors = (page.ancestors || []).map((x) => ({ id: String(x.id), title: x.title }));
  const metadata = {
    pageId: String(page.id),
    title: page.title,
    url: page._links?.webui ? api.absolute(page._links.webui) : null,
    spaceKey: space,
    status: page.status || 'current',
    version: { number: page.version?.number ?? null },
    updatedAt: page.version?.when ?? null,
    parentId: ancestors.length ? ancestors[ancestors.length - 1].id : null,
    ancestors,
    labels: (page.metadata?.labels?.results || []).map((l) => l.name),
    attachments,
    fetchedAt: new Date().toISOString(),
  };
  writeFile(path.join(tmp, 'page.html'), page.body?.view?.value || '');
  writeFile(path.join(tmp, 'page.storage.xml'), page.body?.storage?.value || '');
  // metadata.json en dernier : un dossier sans lui n'est pas considéré comme une page complète
  writeFile(path.join(tmp, 'metadata.json'), JSON.stringify(metadata, null, 2));

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);
  return { folder, version: metadata.version.number, title: page.title, space, attachments: attachments.length, skipped };
}

/**
 * @param {object} p
 * @param {object} p.api       createConfluenceApi(...)
 * @param {string} p.root      dossier d'export (CONFLUENCE_EXPORT_DIR)
 * @param {string[]} p.spaces  clés des espaces
 * @param {object} [p.options] { full, limit, concurrency, downloadImages, maxAttachmentBytes, dryRun }
 * @param {object} [p.logger]
 */
async function fetchSpaces({ api, root, spaces, options = {}, logger = null }) {
  const { full = false, limit = Infinity, concurrency = 4, dryRun = false } = options;
  fs.mkdirSync(root, { recursive: true });
  const state = readState(root);
  const stats = { spaces: 0, listed: 0, fetched: 0, unchanged: 0, renamed: 0, deleted: 0, errors: 0, attachments: 0, skippedAttachments: 0 };
  const errors = [];
  const seen = new Set();
  const listedSpaces = new Set();
  const run = createLimiter(concurrency);
  let sinceSave = 0;

  const todo = [];
  for (const space of spaces) {
    let pages;
    try {
      pages = await api.listPages(space);
    } catch (err) {
      stats.errors++;
      errors.push({ ref: space, step: 'liste', message: err.message });
      logger?.error(`espace ${space} : liste impossible, rien n'est supprimé pour cet espace (${err.message})`);
      continue;
    }
    const known = Object.values(state.pages).filter((x) => x.space === space).length;
    if (!pages.length && known) {
      logger?.warn(`espace ${space} : 0 page renvoyée alors que ${known} étaient connues ; suppression annulée par sécurité`);
      for (const [id, x] of Object.entries(state.pages)) if (x.space === space) seen.add(id);
      continue;
    }
    stats.spaces++;
    listedSpaces.add(space);
    stats.listed += pages.length;
    for (const s of pages) {
      const id = String(s.id);
      seen.add(id);
      const prev = state.pages[id];
      const version = s.version?.number ?? null;
      const exists = prev && fs.existsSync(path.join(root, prev.folder, 'metadata.json'));
      if (!full && exists && prev.version === version) {
        stats.unchanged++;
        continue;
      }
      todo.push({ id, title: s.title, spaceKey: space, prev });
    }
  }

  const selected = todo.slice(0, limit);
  logger?.info(`${stats.listed} pages listées, ${todo.length} nouvelles ou modifiées${selected.length < todo.length ? ` (${selected.length} traitées : --limit)` : ''}`);

  await Promise.all(
    selected.map((s) =>
      run(async () => {
        if (dryRun) {
          stats.fetched++;
          return;
        }
        try {
          const r = await fetchPage(api, root, s, options);
          // titre ou espace changé : l'ancien dossier est retiré
          if (s.prev && s.prev.folder !== r.folder) {
            fs.rmSync(path.join(root, s.prev.folder), { recursive: true, force: true });
            stats.renamed++;
          }
          state.pages[s.id] = { space: r.space, version: r.version, folder: r.folder, title: r.title };
          stats.fetched++;
          stats.attachments += r.attachments;
          stats.skippedAttachments += r.skipped.length;
          if (r.skipped.length) logger?.warn(`page ${s.id} : pièces jointes trop lourdes ignorées`, r.skipped);
        } catch (err) {
          stats.errors++;
          errors.push({ ref: s.id, step: 'page', message: err.message });
          logger?.warn(`page ${s.id} (${s.title}) : ${err.message}`);
        }
        if (++sinceSave >= 50) {
          sinceSave = 0;
          writeState(root, state);
          logger?.info('progression', { fetched: stats.fetched, errors: stats.errors, reste: selected.length - stats.fetched - stats.errors });
        }
      })
    )
  );

  // pages disparues de Confluence (seulement pour les espaces listés avec succès, et pas en mode --limit)
  if (limit === Infinity && !dryRun) {
    for (const [id, x] of Object.entries(state.pages)) {
      if (seen.has(id) || !listedSpaces.has(x.space)) continue;
      fs.rmSync(path.join(root, x.folder), { recursive: true, force: true });
      delete state.pages[id];
      stats.deleted++;
    }
  }
  const now = new Date().toISOString();
  for (const space of listedSpaces) state.spaces[space] = { lastRun: now };
  if (!dryRun) writeState(root, state);
  return { stats, errors };
}

module.exports = { fetchSpaces, fetchPage, safeName, pageFolder, readState, STATE_FILE };
