'use strict';
/**
 * Accès aux données du graphe. Toutes les écritures sont idempotentes :
 * relancer une synchro donne le même résultat.
 *
 * C'est le SEUL module qui lit/écrit les données (via store.js). Le reste du projet
 * ne connaît que les fonctions renvoyées par createRepo.
 */
const { canonicalHost, hostAliases } = require('../resolve/entities');

/** Horodatage au même format que l'ancienne base (UTC, "AAAA-MM-JJ HH:MM:SS"). */
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const toNode = (n) => n && { id: n.id, type: n.type, name: n.name, attrs: { ...n.attrs }, updatedAt: n.updatedAt };
const toEdge = (e) =>
  e && { id: e.id, src: e.src, dst: e.dst, type: e.type, source: e.source, sourceRef: e.source_ref, confidence: e.confidence, attrs: { ...e.attrs }, updatedAt: e.updated_at };

/** Clé canonique selon le type d'entité. */
function nodeKey(type, raw) {
  if (type === 'server') return canonicalHost(raw);
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function applyPatch(attrs, patch) {
  const out = { ...attrs, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete out[k];
  return out;
}

function createRepo(store) {
  const D = () => store.data; // les données peuvent être rechargées : toujours passer par D()

  function addAliasRaw(alias, nodeId, source) {
    const a = String(alias || '').trim();
    if (!a) return;
    const aliases = D().aliases;
    if (!aliases.has(a)) aliases.set(a, new Map());
    const m = aliases.get(a);
    if (!m.has(nodeId)) m.set(nodeId, source); // INSERT OR IGNORE
  }

  /**
   * Crée ou met à jour un nœud. Les attributs sont fusionnés (une source n'efface pas l'autre).
   * @returns {string} id du nœud
   */
  function upsertNode({ type, key, name, attrs = {}, source = 'unknown', aliases = [] }) {
    const k = nodeKey(type, key ?? name);
    if (!k) throw new Error(`Clé vide pour un nœud de type ${type}`);
    const id = `${type}:${k}`;
    const nodes = D().nodes;
    const existing = nodes.get(id);
    if (existing) {
      existing.name = name || existing.name;
      existing.attrs = { ...existing.attrs, ...attrs };
      existing.updatedAt = now();
    } else {
      const t = now();
      nodes.set(id, { id, type, name: name || k, attrs: { ...attrs }, createdAt: t, updatedAt: t });
    }
    const all = new Set([k, String(name || '').toLowerCase(), ...aliases.map((a) => String(a).toLowerCase())]);
    if (type === 'server') for (const a of [key, name, ...aliases]) for (const h of hostAliases(a)) all.add(h);
    for (const a of all) if (a) addAliasRaw(a, id, source);
    return id;
  }

  const addAlias = (nodeId, alias, source = 'manual') => addAliasRaw(String(alias).trim().toLowerCase(), nodeId, source);

  function nodesByAlias(alias) {
    const m = D().aliases.get(alias);
    return m ? [...m.keys()].map((id) => D().nodes.get(id)).filter(Boolean) : [];
  }

  /** Retrouve les nœuds correspondant à un nom, FQDN ou IP. */
  function resolve(text) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return [];
    const found = new Map();
    for (const candidate of new Set([s, ...hostAliases(s)])) for (const n of nodesByAlias(candidate)) found.set(n.id, toNode(n));
    return [...found.values()];
  }

  function addEdge({ src, dst, type, source, sourceRef = '', confidence = 1, attrs = {} }) {
    if (!src || !dst || src === dst) return;
    const data = D();
    const row = { src, dst, type, source, source_ref: String(sourceRef), confidence, attrs: { ...attrs }, updated_at: now() };
    const k = store.edgeKey(row);
    const existing = data.edges.get(k);
    if (existing) {
      existing.confidence = confidence;
      existing.attrs = row.attrs;
      existing.updated_at = row.updated_at;
      return;
    }
    row.id = ++data.seq.edge;
    data.edges.set(k, row);
    store.indexEdge(k, row);
  }

  /**
   * Supprime les liens d'une page (même `sourceRef`) dont la source figure dans `sources`.
   * Les liens des inventaires (autres sources) ne sont jamais touchés. Renvoie le nombre supprimé.
   */
  function removeEdgesBySourceRef(sourceRef, { sources = [] } = {}) {
    const data = D();
    const ref = String(sourceRef);
    let n = 0;
    // suppression pendant le parcours : sûre sur une Map (aucune copie de tous les liens à chaque page)
    for (const [k, e] of data.edges) {
      if (e.source_ref !== ref || !sources.includes(e.source)) continue;
      data.edges.delete(k);
      for (const [index, id] of [[data.edgesBySrc, e.src], [data.edgesByDst, e.dst]]) {
        const set = index.get(id);
        if (!set) continue;
        set.delete(k);
        if (!set.size) index.delete(id);
      }
      n++;
    }
    return n;
  }

  /** Fusionne un patch dans les attributs d'un nœud ; une valeur undefined supprime l'attribut. */
  function patchNodeAttrs(id, patch) {
    const n = D().nodes.get(id);
    if (!n) return false;
    n.attrs = applyPatch(n.attrs, patch);
    return true;
  }

  /** Idem pour un lien, désigné par son id numérique. */
  function patchEdgeAttrs(edgeId, patch) {
    for (const e of D().edges.values()) {
      if (e.id === edgeId) {
        e.attrs = applyPatch(e.attrs, patch);
        return true;
      }
    }
    return false;
  }

  const allEdges = () => [...D().edges.values()].map(toEdge);

  const getNode = (id) => toNode(D().nodes.get(id));
  const edgesOf = (index, id) => [...(index.get(id) || [])].map((k) => toEdge(D().edges.get(k))).filter(Boolean);
  const edgesFrom = (id) => edgesOf(D().edgesBySrc, id);
  const edgesTo = (id) => edgesOf(D().edgesByDst, id);

  /** Recherche par nom ou alias (sous-chaîne, sans tenir compte de la casse). */
  function search(q, limit = 20) {
    const needle = String(q || '').toLowerCase();
    if (!needle) return [];
    const ids = new Set();
    for (const n of D().nodes.values()) if (n.name.toLowerCase().includes(needle)) ids.add(n.id);
    for (const [alias, m] of D().aliases) if (alias.includes(needle)) for (const id of m.keys()) ids.add(id);
    return [...ids]
      .map((id) => D().nodes.get(id))
      .filter(Boolean)
      .sort((a, b) => byText(a.type, b.type) || byText(a.name, b.name))
      .slice(0, limit)
      .map(toNode);
  }

  const listByType = (type) =>
    [...D().nodes.values()]
      .filter((n) => n.type === type)
      .sort((a, b) => byText(a.name, b.name))
      .map(toNode);

  function countByType() {
    const out = {};
    for (const n of D().nodes.values()) out[n.type] = (out[n.type] || 0) + 1;
    return out;
  }

  // ---------- suivi des synchronisations ----------
  function startRun(source) {
    const data = D();
    const id = ++data.seq.run;
    data.runs.push({ id, source, started_at: now(), finished_at: null, status: 'running', stats: {}, error: null });
    return id;
  }
  function finishRun(runId, { status = 'success', stats = {}, error = null } = {}) {
    const run = D().runs.find((r) => r.id === runId);
    if (!run) return;
    Object.assign(run, { finished_at: now(), status, stats: stats || {}, error });
  }
  function recordError(runId, { source, ref = null, step, message }) {
    const data = D();
    data.errors.push({ id: ++data.seq.error, run_id: runId, source, ref: ref === null ? null : String(ref), step, message: String(message).slice(0, 2000), at: now() });
  }
  const lastRuns = (limit = 20) =>
    D()
      .runs.slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((r) => ({ ...r, stats: { ...r.stats } }));
  const errorsOfRun = (runId) =>
    D()
      .errors.filter((e) => e.run_id === runId)
      .map((e) => ({ ...e }));

  // ---------- documents (suivi du traitement, pour l'incrémental) ----------
  const getDocument = (id) => {
    const d = D().documents.get(id);
    return d ? { ...d } : null;
  };
  function saveDocument({ id, source, title = null, url = null, version = null, updatedAt = null, contentHash = null, status, error = null, attrs = {} }) {
    D().documents.set(id, { id, source, title, url, version, updated_at: updatedAt, content_hash: contentHash, status, error, processed_at: now(), attrs });
  }
  const documentsByStatus = (status) =>
    [...D().documents.values()]
      .filter((d) => d.status === status)
      .sort((a, b) => byText(a.id, b.id))
      .map((d) => ({ ...d }));

  /** Exécute fn ; en mémoire, il n'y a pas de transaction à ouvrir (gardé pour la compatibilité). */
  const transaction = (fn) => fn();

  return {
    store,
    transaction,
    flush: () => store.flush(),
    reloadIfChanged: () => store.reloadIfChanged(),
    getDocument,
    saveDocument,
    documentsByStatus,
    upsertNode,
    addAlias,
    resolve,
    addEdge,
    removeEdgesBySourceRef,
    getNode,
    patchNodeAttrs,
    patchEdgeAttrs,
    allEdges,
    edgesFrom,
    edgesTo,
    search,
    listByType,
    countByType,
    startRun,
    finishRun,
    recordError,
    lastRuns,
    errorsOfRun,
  };
}

module.exports = { createRepo, nodeKey };
