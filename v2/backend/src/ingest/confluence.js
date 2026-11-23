'use strict';
/**
 * Intègre une page Confluence analysée dans le graphe (étape SANS IA) :
 *  - nœud "document" pour la page
 *  - liens "mentions" vers les serveurs/IP connus cités dans le texte
 *  - liens entre entités tirés des diagrammes draw.io (si les deux boîtes
 *    correspondent à des entités connues)
 * Ce qui n'est pas reconnu est gardé dans `unresolved` pour revue ou pour l'IA.
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
 * @param {object} repo
 * @param {object} page   résultat de parseStoragePage
 * @param {object} [opts] { drawioResults: résultats de parseDrawio pour les diagrammes de la page, url }
 */
function ingestConfluencePage(repo, page, { drawioResults = [], url = null, attrs = {} } = {}) {
  const docId = repo.upsertNode({
    type: 'document',
    key: documentId(page.id),
    name: page.title || page.id,
    source: 'confluence',
    attrs: { url, space: page.spaceKey, version: page.version, updatedAt: page.updatedAt, labels: page.labels, obsoleteFragments: page.obsoleteFragments || 0, ...attrs },
  });
  // date de la page source, gardée sur chaque lien : une page de 2010 ne vaut pas une page récente
  const linkAttrs = page.updatedAt ? { pageUpdatedAt: page.updatedAt } : {};
  const ref = page.id;
  const stats = { mentions: 0, diagramLinks: 0, unresolved: [] };

  // 1. mentions de serveurs / IP connus (on ne crée PAS de serveur à partir d'un texte libre)
  for (const token of [...page.entities.hosts, ...page.entities.ips]) {
    const matches = repo.resolve(token);
    if (!matches.length) {
      stats.unresolved.push(token);
      continue;
    }
    for (const n of matches) {
      repo.addEdge({ src: docId, dst: n.id, type: 'mentions', source: 'confluence', sourceRef: ref, confidence: 0.9, attrs: linkAttrs });
      stats.mentions++;
    }
  }

  // 2. la page documente une application connue :
  //    - titre = nom de l'application (0.8), ou début du titre ("OrderHub - Servers" -> OrderHub) (0.7)
  //    - sinon une page parente porte le nom de l'application (hiérarchie Confluence) (0.6)
  const documented = new Map();
  const tryName = (name, confidence) => {
    for (const n of repo.resolve(name)) {
      if (n.type === 'application' && !(documented.get(n.id) >= confidence)) documented.set(n.id, confidence);
    }
  };
  tryName(page.title, 0.8);
  const prefix = String(page.title || '').split(/\s+[-–—:|]\s+/)[0];
  if (prefix && prefix !== page.title) tryName(prefix, 0.7);
  for (const a of page.ancestors || []) tryName(a, 0.6);
  for (const [appId, confidence] of documented) {
    repo.addEdge({ src: appId, dst: docId, type: 'documented_in', source: 'confluence', sourceRef: ref, confidence, attrs: linkAttrs });
  }

  // 3. diagrammes draw.io : flèche A -> B entre deux entités connues
  for (const d of drawioResults) {
    for (const p of d.pages) {
      for (const e of p.edges) {
        if (e.dangling || !e.sourceLabel || !e.targetLabel) continue;
        const [a] = repo.resolve(e.sourceLabel);
        const [b] = repo.resolve(e.targetLabel);
        if (!a || !b) {
          stats.unresolved.push(`${e.sourceLabel} -> ${e.targetLabel}`);
          continue;
        }
        const type = b.type === 'database' ? 'uses_db' : b.type === 'server' ? 'runs_on' : 'calls';
        repo.addEdge({ src: a.id, dst: b.id, type, source: 'drawio', sourceRef: ref, confidence: 0.8, attrs: { label: e.label, diagramPage: p.name, ...linkAttrs } });
        stats.diagramLinks++;
      }
      for (const c of p.containment) {
        const [parent] = repo.resolve(c.parentLabel || '');
        const [child] = repo.resolve(c.childLabel || '');
        if (parent && child) {
          // une appli dessinée dans la boîte d'un serveur tourne sur ce serveur
          const type = parent.type === 'server' && child.type === 'application' ? 'runs_on' : null;
          if (type) repo.addEdge({ src: child.id, dst: parent.id, type, source: 'drawio', sourceRef: ref, confidence: 0.7, attrs: linkAttrs });
        }
      }
    }
  }
  return stats;
}

const contentHash = (page) => sha256(page.storage || '');

module.exports = { ingestConfluencePage, normalizeExportedPage, documentId, contentHash };
