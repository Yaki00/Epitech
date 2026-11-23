'use strict';
/**
 * Analyse d'impact = parcours du graphe (déterministe, vérifiable).
 * L'IA ne calcule pas l'impact : elle l'explique à partir de ce résultat.
 *
 * Convention : un lien src -> dst signifie "src dépend de dst".
 *  - impact (upstream)       : qui est touché si `nodeId` tombe ? => on remonte les liens entrants
 *  - dependencies (downstream): de quoi `nodeId` a besoin ?       => on suit les liens sortants
 */

// Les liens documentaires ne propagent pas une panne.
const NON_PROPAGATING = new Set(['mentions', 'documented_in', 'monitored_by']);

function traverse(repo, startId, { direction = 'upstream', maxDepth = 5, minConfidence = 0.5, edgeTypes = null, includeRetired = false } = {}) {
  const start = repo.getNode(startId);
  if (!start) return null;
  const visited = new Map([[startId, { node: start, depth: 0, via: null }]]);
  const usedEdges = [];
  let frontier = [startId];

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      const edges = direction === 'upstream' ? repo.edgesTo(id) : repo.edgesFrom(id);
      for (const e of edges) {
        if (e.confidence < minConfidence) continue;
        if (!includeRetired && e.attrs && e.attrs.retired) continue;
        if (edgeTypes ? !edgeTypes.includes(e.type) : NON_PROPAGATING.has(e.type)) continue;
        const otherId = direction === 'upstream' ? e.src : e.dst;
        usedEdges.push(e);
        if (visited.has(otherId)) continue;
        const node = repo.getNode(otherId);
        if (!node) continue;
        if (!includeRetired && node.attrs.retired) continue;
        visited.set(otherId, { node, depth, via: { edgeType: e.type, from: id, source: e.source, confidence: e.confidence } });
        next.push(otherId);
      }
    }
    frontier = next;
  }

  const items = [...visited.values()].filter((v) => v.depth > 0).sort((a, b) => a.depth - b.depth || a.node.name.localeCompare(b.node.name));
  const byType = {};
  for (const v of items) (byType[v.node.type] ||= []).push(v.node.id);

  return {
    start,
    direction,
    total: items.length,
    byType,
    items: items.map((v) => ({ id: v.node.id, name: v.node.name, type: v.node.type, depth: v.depth, via: v.via })),
    elements: toCytoscape(visited, usedEdges),
  };
}

/** Format directement consommable par cytoscape côté front. */
function toCytoscape(visited, edges) {
  const seen = new Set();
  return {
    nodes: [...visited.values()].map((v) => ({ data: { id: v.node.id, label: v.node.name, type: v.node.type, depth: v.depth } })),
    edges: edges
      .filter((e) => visited.has(e.src) && visited.has(e.dst) && !seen.has(e.id) && seen.add(e.id))
      .map((e) => ({ data: { id: `e${e.id}`, source: e.src, target: e.dst, type: e.type, confidence: e.confidence, origin: e.source } })),
  };
}

const impactOf = (repo, id, opts) => traverse(repo, id, { ...opts, direction: 'upstream' });
const dependenciesOf = (repo, id, opts) => traverse(repo, id, { ...opts, direction: 'downstream' });

/** Voisinage direct dans les deux sens (vue "Architecture" d'une application). */
function neighborhood(repo, id, { depth = 2 } = {}) {
  const up = impactOf(repo, id, { maxDepth: depth, edgeTypes: null });
  const down = dependenciesOf(repo, id, { maxDepth: depth });
  if (!up || !down) return null;
  const nodes = new Map();
  const edges = new Map();
  for (const r of [up, down]) {
    for (const n of r.elements.nodes) nodes.set(n.data.id, n);
    for (const e of r.elements.edges) edges.set(e.data.id, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

module.exports = { impactOf, dependenciesOf, neighborhood, traverse };
