import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

cytoscape.use(dagre);

const COLORS = {
  application: '#2563eb',
  server: '#0f766e',
  database: '#b45309',
  filesystem: '#64748b',
  queue: '#7c3aed',
  url: '#475569',
  document: '#94a3b8',
  unknown: '#94a3b8',
};

const STYLE = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'background-color': (n) => COLORS[n.data('type')] || COLORS.unknown,
      color: '#0f172a',
      'font-size': 11,
      'font-family': 'Segoe UI, Inter, system-ui, sans-serif',
      'text-valign': 'bottom',
      'text-margin-y': 6,
      width: 34,
      height: 34,
      'border-width': 3,
      'border-color': '#ffffff',
    },
  },
  { selector: 'node[type = "server"]', style: { shape: 'round-rectangle' } },
  { selector: 'node[type = "database"]', style: { shape: 'barrel' } },
  { selector: 'node.root', style: { width: 46, height: 46, 'font-weight': 700, 'font-size': 13, 'border-color': '#bfdbfe', 'border-width': 6 } },
  {
    selector: 'edge',
    style: {
      width: 2,
      'line-color': '#cbd5e1',
      'target-arrow-color': '#cbd5e1',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 9,
      color: '#64748b',
      'text-background-color': '#f8fafc',
      'text-background-opacity': 1,
      'text-background-padding': 2,
    },
  },
  { selector: 'edge[confidence < 1]', style: { 'line-style': 'dashed' } },
  { selector: 'node.faded, edge.faded', style: { opacity: 0.15 } },
  { selector: 'node.impacted', style: { 'border-color': '#fca5a5', 'border-width': 6 } },
  { selector: 'node.failing', style: { 'background-color': '#dc2626', 'border-color': '#fecaca', 'border-width': 8 } },
  { selector: 'edge.impacted', style: { 'line-color': '#f87171', 'target-arrow-color': '#f87171', width: 3 } },
];

/**
 * Graphe cytoscape (layout dagre gauche -> droite).
 * @param elements  { nodes, edges } au format renvoyé par /api/graph
 * @param rootId    nœud mis en avant
 * @param highlight { failing: id, impacted: [ids] } pour la simulation de panne
 * @param onNodeClick (data) => void
 * @param edgeLabel   (type) => libellé affiché sur un lien
 */
export default function GraphView({ elements, rootId, highlight, onNodeClick, height = 520, edgeLabel = (x) => x }) {
  // libellé des liens dans la langue de l'interface (runs_on -> "tourne sur" / "runs on")
  const edgeText = edgeLabel('runs_on') + edgeLabel('calls');
  const ref = useRef(null);
  const cyRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !elements) return undefined;
    const cy = cytoscape({
      container: ref.current,
      elements: [...elements.nodes, ...elements.edges.map((e) => ({ ...e, data: { ...e.data, label: edgeLabel(e.data.type) } }))],
      style: STYLE,
      layout: { name: 'dagre', rankDir: 'LR', nodeSep: 40, rankSep: 110, padding: 30 },
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 2.5,
    });
    if (rootId) cy.getElementById(rootId).addClass('root');
    cy.on('tap', 'node', (e) => onNodeClick?.(e.target.data()));
    cyRef.current = cy;
    return () => cy.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, rootId, edgeText]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('faded impacted failing');
    if (!highlight?.failing) return;
    const hit = new Set([highlight.failing, ...(highlight.impacted || [])]);
    cy.nodes().forEach((n) => {
      if (n.id() === highlight.failing) n.addClass('failing');
      else if (hit.has(n.id())) n.addClass('impacted');
      else n.addClass('faded');
    });
    cy.edges().forEach((e) => (hit.has(e.source().id()) && hit.has(e.target().id()) ? e.addClass('impacted') : e.addClass('faded')));
  }, [highlight, elements, edgeText]); // le graphe est recréé au changement de langue : on remet la simulation

  return <div ref={ref} style={{ height }} className="w-full rounded-xl bg-slate-50" />;
}

export { COLORS as GRAPH_COLORS };
