'use strict';
/**
 * Historique des imports d'inventaire et retrait des éléments disparus.
 *  - snapshots.json : dernier ensemble vu par source (nœuds, liens, attributs suivis)
 *  - changes.json   : ajouts / retraits / modifications entre deux imports (HISTORY_KEEP entrées)
 * Un import incomplet n'enregistre rien et ne retire rien. Rien n'est jamais supprimé du graphe.
 */
const path = require('path');
const { writeJsonAtomic, readJson } = require('../store/store');

const DEFAULT_KEEP = 50;
const nowIso = () => new Date().toISOString();
const edgeId = (e) => `${e.src}|${e.dst}|${e.type}|${e.source}`;

function createHistory(dataDir, { keep = DEFAULT_KEEP } = {}) {
  const snapFile = path.join(dataDir, 'snapshots.json');
  const changesFile = path.join(dataDir, 'changes.json');
  const limit = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;

  const loadSnapshots = () => readJson(snapFile, {});
  const loadChanges = () => readJson(changesFile, []);

  /**
   * @returns {object|null} l'entrée d'historique créée (null : import incomplet, premier import ou rien de changé)
   */
  function recordImport({ source, seen, attrsById = {}, complete = false }) {
    if (!complete || !seen) return null;
    const snaps = loadSnapshots();
    const prev = snaps[source];
    const next = { at: nowIso(), nodeIds: seen.nodeIds || [], edgeIds: seen.edgeIds || [], attrs: attrsById };
    snaps[source] = next;
    writeJsonAtomic(snapFile, snaps);
    if (!prev) return null; // premier import : simple point de départ

    const prevAll = new Set([...prev.nodeIds, ...prev.edgeIds]);
    const nextAll = new Set([...next.nodeIds, ...next.edgeIds]);
    const added = [...nextAll].filter((id) => !prevAll.has(id));
    const removed = [...prevAll].filter((id) => !nextAll.has(id));
    const changed = [];
    for (const [id, now] of Object.entries(next.attrs)) {
      const before = prev.attrs[id];
      if (!before) continue;
      for (const attr of new Set([...Object.keys(before), ...Object.keys(now)])) {
        if (String(before[attr] ?? '') !== String(now[attr] ?? '')) changed.push({ id, attr, before: before[attr] ?? null, after: now[attr] ?? null });
      }
    }
    if (!added.length && !removed.length && !changed.length) return null;
    const entry = { at: next.at, source, added, removed, changed };
    writeJsonAtomic(changesFile, [entry, ...loadChanges()].slice(0, limit));
    return entry;
  }

  /** Dernières entrées, la plus récente d'abord. */
  const list = (n = limit) => loadChanges().slice(0, n);

  /** Marque (ou réactive) nœuds serveur et liens d'inventaire d'après les derniers instantanés. */
  function applyRetirements(repo) {
    const snaps = loadSnapshots();
    const sources = Object.keys(snaps);
    if (!sources.length) return { nodes: 0, edges: 0 };
    const liveNodes = new Set(sources.flatMap((s) => snaps[s].nodeIds));
    const liveEdges = new Set(sources.flatMap((s) => snaps[s].edgeIds));
    let nodes = 0;
    let edges = 0;
    const t = nowIso();

    for (const node of repo.listByType('server')) {
      // seuls les serveurs créés par un inventaire suivi sont concernés
      if (!sources.some((s) => node.attrs[`${s}_row`] !== undefined)) continue;
      if (liveNodes.has(node.id)) {
        if (node.attrs.retired) repo.patchNodeAttrs(node.id, { retired: undefined, retiredAt: undefined });
      } else if (!node.attrs.retired) {
        repo.patchNodeAttrs(node.id, { retired: true, retiredAt: t });
        nodes++;
      }
    }
    for (const e of repo.allEdges()) {
      if (!snaps[e.source]) continue;
      if (liveEdges.has(edgeId(e))) {
        if (e.attrs.retired) repo.patchEdgeAttrs(e.id, { retired: undefined, retiredAt: undefined });
      } else if (!e.attrs.retired) {
        repo.patchEdgeAttrs(e.id, { retired: true, retiredAt: t });
        edges++;
      }
    }
    return { nodes, edges };
  }

  return { recordImport, list, applyRetirements };
}

module.exports = { createHistory };
