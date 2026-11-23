'use strict';
/**
 * Analyse d'une page Confluence au format "storage" (body.storage.value), SANS IA.
 * Sort : sections (découpées par titres), tableaux structurés, liens entre pages,
 * pièces jointes, images, diagrammes draw.io/Gliffy, tickets Jira, entités (IP, hôtes…).
 */
const { parseXml, walk, textOf, removeElements, isObsolete } = require('../../lib/xml');
const { extractEntities } = require('../../resolve/entities');

const HEADING = /^h([1-6])$/;
const param = (macro, name) => {
  const p = macro.children.find((c) => c.type === 'element' && c.name === 'ac:parameter' && c.attrs['ac:name'] === name);
  return p ? textOf(p) : undefined;
};

function tableToJson(table) {
  // lignes du tableau, sans descendre dans les tableaux imbriqués
  const rows = [];
  walk(table, (n) => {
    if (n.type !== 'element') return;
    if (n.name === 'table' && n !== table) return false;
    if (n.name === 'tr') rows.push(n);
  });
  const cells = (tr) => tr.children.filter((c) => c.type === 'element' && (c.name === 'td' || c.name === 'th'));
  if (!rows.length) return null;
  const firstCells = cells(rows[0]);
  const hasHeader = firstCells.length && firstCells.every((c) => c.name === 'th');
  const headers = hasHeader ? firstCells.map((c, i) => textOf(c) || `col${i + 1}`) : firstCells.map((_, i) => `col${i + 1}`);
  const body = hasHeader ? rows.slice(1) : rows;
  const records = body
    .map((tr) => {
      const cs = cells(tr);
      return Object.fromEntries(headers.map((h, i) => [h, cs[i] ? textOf(cs[i]) : '']));
    })
    .filter((r) => Object.values(r).some((v) => v));
  return { headers, rows: records };
}

const tableToText = (t) =>
  [t.headers.join(' | '), ...t.rows.map((r) => t.headers.map((h) => r[h]).join(' | '))].join('\n');

/**
 * @param {string} storage  XHTML storage de la page
 * @param {object} [meta]   { id, title, spaceKey, version, updatedAt, ancestors, labels }
 */
function parseStoragePage(storage, meta = {}) {
  const doc = parseXml(storage || '');
  // texte barré = information obsolète (ancien serveur, ancien contact…) : on ne l'exploite pas
  const obsoleteFragments = removeElements(doc, isObsolete);

  // --- liens, pièces jointes, images, macros ---
  const pageLinks = [];
  const attachments = new Set();
  const images = [];
  const macros = [];
  const diagrams = [];
  const jiraKeys = new Set();

  walk(doc, (n, parents) => {
    if (n.type !== 'element') return;
    if (n.name === 'ri:page') {
      pageLinks.push({ title: n.attrs['ri:content-title'], spaceKey: n.attrs['ri:space-key'] || meta.spaceKey });
    } else if (n.name === 'ri:attachment') {
      const filename = n.attrs['ri:filename'];
      if (filename) attachments.add(filename);
      if (parents.some((p) => p.name === 'ac:image')) images.push({ kind: 'attachment', filename });
    } else if (n.name === 'ri:url' && parents.some((p) => p.name === 'ac:image')) {
      images.push({ kind: 'url', url: n.attrs['ri:value'] });
    } else if (n.name === 'ac:structured-macro') {
      const name = (n.attrs['ac:name'] || '').toLowerCase();
      const params = {};
      for (const c of n.children) if (c.type === 'element' && c.name === 'ac:parameter') params[c.attrs['ac:name']] = textOf(c);
      macros.push({ name, params });
      if (name === 'drawio' || name === 'drawio-sketch' || name === 'inc-drawio') {
        diagrams.push({ type: 'drawio', name: param(n, 'diagramName'), pageId: param(n, 'pageId') });
      } else if (name === 'gliffy') {
        diagrams.push({ type: 'gliffy', name: param(n, 'name') });
      } else if (name === 'jira' && params.key) {
        jiraKeys.add(params.key);
      }
    }
  });

  // --- sections + tableaux, dans l'ordre du document ---
  const sections = [];
  const tables = [];
  let current = { heading: meta.title || '', level: 0, parts: [] };
  const flush = () => {
    const text = current.parts.join(' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    if (text) sections.push({ heading: current.heading, level: current.level, text });
  };

  walk(doc, (n) => {
    if (n.type === 'text') {
      current.parts.push(n.value);
      return;
    }
    const h = n.name.match(HEADING);
    if (h) {
      flush();
      current = { heading: textOf(n), level: Number(h[1]), parts: [] };
      return false;
    }
    if (n.name === 'table') {
      const t = tableToJson(n);
      if (t) {
        tables.push({ section: current.heading, ...t });
        current.parts.push('\n' + tableToText(t) + '\n');
      }
      return false;
    }
    if (n.name === 'ac:parameter') return false; // paramètres de macro : pas du contenu
    if (['p', 'li', 'br', 'div', 'tr'].includes(n.name)) current.parts.push('\n');
  });
  flush();

  const text = sections.map((s) => (s.heading ? `${s.heading}\n${s.text}` : s.text)).join('\n\n');

  return {
    id: meta.id,
    title: meta.title,
    spaceKey: meta.spaceKey,
    version: meta.version,
    updatedAt: meta.updatedAt,
    labels: meta.labels || [],
    ancestors: meta.ancestors || [],
    text,
    sections,
    tables,
    pageLinks,
    attachments: [...attachments],
    images,
    macros,
    diagrams,
    jiraKeys: [...jiraKeys],
    entities: extractEntities(text),
    obsoleteFragments,
  };
}

module.exports = { parseStoragePage, tableToJson, tableToText };
