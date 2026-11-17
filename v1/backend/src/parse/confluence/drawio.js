'use strict';
/**
 * Lecture des diagrammes draw.io (pièces jointes Confluence) SANS modèle de vision.
 * Un diagramme est du XML : les boîtes (vertex) deviennent des nœuds, les flèches
 * (edge) des liens, et les conteneurs donnent des relations "contient".
 *
 * Formats gérés :
 *  - <mxfile><diagram>BASE64(deflate-raw(encodeURIComponent(xml)))</diagram></mxfile>
 *  - <mxfile><diagram><mxGraphModel>…</mxGraphModel></diagram></mxfile>
 *  - <mxGraphModel>…</mxGraphModel> seul
 */
const zlib = require('zlib');
const { parseXml, findAll, walk, decodeEntities } = require('../../lib/xml');

function inflateDiagram(payload) {
  const buf = Buffer.from(payload.trim(), 'base64');
  const inflated = zlib.inflateRawSync(buf).toString('utf8');
  try {
    return decodeURIComponent(inflated);
  } catch {
    return inflated;
  }
}

/** Libellé lisible : le HTML des labels draw.io est retiré. */
function cleanLabel(s) {
  if (!s) return '';
  return decodeEntities(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const styleOf = (s) =>
  Object.fromEntries(
    String(s || '')
      .split(';')
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf('=');
        return i === -1 ? [kv, true] : [kv.slice(0, i), kv.slice(i + 1)];
      })
  );

function parseGraphModel(modelNode, name) {
  const cells = [];
  // une cellule peut être enveloppée dans <UserObject>/<object> qui porte le label et des attributs métier
  walk(modelNode, (n, parents) => {
    if (n.type !== 'element' || n.name !== 'mxcell') return;
    const wrapper = parents[parents.length - 1];
    const wrapped = wrapper && (wrapper.name === 'userobject' || wrapper.name === 'object');
    const attrs = wrapped ? { ...wrapper.attrs, ...n.attrs, id: wrapper.attrs.id ?? n.attrs.id } : n.attrs;
    const label = cleanLabel(wrapped ? wrapper.attrs.label ?? n.attrs.value : n.attrs.value);
    const props = wrapped
      ? Object.fromEntries(Object.entries(wrapper.attrs).filter(([k]) => !['id', 'label', 'placeholders'].includes(k)))
      : {};
    cells.push({ id: attrs.id, parent: attrs.parent, label, style: attrs.style, vertex: attrs.vertex === '1', edge: attrs.edge === '1', source: attrs.source, target: attrs.target, props });
  });

  const byId = new Map(cells.map((c) => [c.id, c]));
  // couches : la racine (sans parent) et ses enfants directs non dessinés
  const rootIds = new Set(cells.filter((c) => !c.parent).map((c) => c.id));
  const layerIds = new Set(cells.filter((c) => rootIds.has(c.parent) && !c.vertex && !c.edge).map((c) => c.id));
  const isStructural = (id) => rootIds.has(id) || layerIds.has(id);

  const edges = cells.filter((c) => c.edge);
  const edgeIds = new Set(edges.map((e) => e.id));

  // libellés posés sur une flèche = enfants d'un edge
  const edgeLabels = new Map();
  for (const c of cells) {
    if (c.vertex && edgeIds.has(c.parent) && c.label) {
      edgeLabels.set(c.parent, [edgeLabels.get(c.parent), c.label].filter(Boolean).join(' '));
    }
  }

  const nodes = cells
    .filter((c) => c.vertex && !edgeIds.has(c.parent))
    .map((c) => {
      const st = styleOf(c.style);
      return {
        id: c.id,
        label: c.label,
        shape: st.shape || (st.ellipse ? 'ellipse' : st.swimlane ? 'swimlane' : st.text ? 'text' : 'rect'),
        parent: isStructural(c.parent) ? null : c.parent,
        props: c.props,
      };
    })
    .filter((n) => n.label || n.parent || Object.keys(n.props).length);

  const nodeIds = new Set(nodes.map((n) => n.id));
  const links = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceLabel: byId.get(e.source)?.label || null,
    targetLabel: byId.get(e.target)?.label || null,
    label: [e.label, edgeLabels.get(e.id)].filter(Boolean).join(' ') || null,
    dangling: !nodeIds.has(e.source) || !nodeIds.has(e.target),
  }));

  const containment = nodes
    .filter((n) => n.parent && nodeIds.has(n.parent))
    .map((n) => ({ parent: n.parent, parentLabel: byId.get(n.parent)?.label || null, child: n.id, childLabel: n.label }));

  return { name, nodes, edges: links, containment };
}

/** @returns {{pages: Array<{name, nodes, edges, containment}>}} */
function parseDrawio(xml) {
  const doc = parseXml(xml);
  const pages = [];
  const diagrams = findAll(doc, (n) => n.name === 'diagram');
  if (diagrams.length) {
    for (const d of diagrams) {
      const name = d.attrs.name || d.attrs.id || 'Page';
      let model = findAll(d, (n) => n.name === 'mxgraphmodel')[0];
      if (!model) {
        const payload = d.children.filter((c) => c.type === 'text').map((c) => c.value).join('').trim();
        if (!payload) continue;
        model = parseXml(inflateDiagram(payload));
      }
      pages.push(parseGraphModel(model, name));
    }
  } else {
    const model = findAll(doc, (n) => n.name === 'mxgraphmodel')[0];
    if (model) pages.push(parseGraphModel(model, 'Page'));
  }
  return { pages };
}

module.exports = { parseDrawio, inflateDiagram, cleanLabel };
