'use strict';
/**
 * Intègre une page Confluence analysée dans le graphe : le nœud "document" et ses attributs.
 * Ce que la page cite (serveurs, applications, liens, responsables) vient seulement de la lecture
 * IA vérifiée (src/reading/), jamais d'un repérage dans le texte.
 */
const { sha256 } = require('../lib/hash');

/** Lit les champs d'une page quel que soit le format d'export (API REST ou script maison). */
function normalizeExportedPage(raw) {
  return {
    id: String(raw.id ?? raw.pageId ?? raw.content_id ?? ''),
    title: raw.title ?? raw.name ?? '',
    spaceKey: raw.space?.key ?? raw.spaceKey ?? raw.space ?? '',
    version: raw.version?.number ?? raw.version ?? null,
    updatedAt: raw.version?.when ?? raw.lastModified ?? raw.updatedAt ?? null,
    url: raw._links?.webui ?? raw.url ?? null,
    labels: (raw.metadata?.labels?.results || raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    ancestors: (raw.ancestors || []).map((a) => (typeof a === 'string' ? a : a.title)),
    storage: raw.body?.storage?.value ?? raw.storage ?? raw.body ?? '',
  };
}

function documentId(pageId) {
  return `confluence-${pageId}`;
}

/**
 * Crée ou met à jour le nœud document de la page.
 * @param {object} repo
 * @param {object} page   page analysée (parseViewPage / parseStoragePage)
 * @param {object} [opts] { url, attrs }
 * @returns {string} id du nœud document
 */
function ingestConfluencePage(repo, page, { url = null, attrs = {} } = {}) {
  return repo.upsertNode({
    type: 'document',
    key: documentId(page.id),
    name: page.title || page.id,
    source: 'confluence',
    attrs: { url, space: page.spaceKey, version: page.version, updatedAt: page.updatedAt, labels: page.labels, obsoleteFragments: page.obsoleteFragments || 0, ...attrs },
  });
}

const contentHash = (page) => sha256(page.storage || '');

module.exports = { ingestConfluencePage, normalizeExportedPage, documentId, contentHash };
