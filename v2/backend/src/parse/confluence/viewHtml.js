'use strict';
/**
 * Analyse d'une page Confluence au format RENDU ("view" : le page.html de l'export local), SANS IA.
 * Même sortie que parseStoragePage (storage.js), pour que la suite (ingest, IA) ne change pas :
 * sections découpées par titres, tableaux, liens entre pages, pièces jointes, images,
 * macros, diagrammes draw.io, tickets Jira, entités (IP, hôtes…), + obsoleteFragments.
 *
 * Le HTML rendu perd les paramètres des macros : si l'export fournit aussi page.storage.xml,
 * l'ingestion reprend les diagrammes et macros depuis le storage (voir mergeStorageMacros).
 */
const { parseXml, walk, textOf, removeElements, isObsolete } = require('../../lib/xml');
const { extractEntities } = require('../../resolve/entities');
const { tableToJson, tableToText } = require('./storage');

const HEADING = /^h([1-6])$/;
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,15}-\d{1,7})\b/;
const hasClass = (n, cls) => ` ${n.attrs.class || ''} `.includes(` ${cls} `);
const fileFromUrl = (u) => {
  const clean = String(u || '').split(/[?#]/)[0];
  try {
    return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1)) || null;
  } catch (_) {
    return clean.slice(clean.lastIndexOf('/') + 1) || null;
  }
};

/** Noms de diagrammes draw.io cités dans le HTML rendu (attributs ou JSON de configuration du plugin). */
function findDrawioNames(rawHtml, doc) {
  const names = new Set();
  walk(doc, (n) => {
    if (n.type !== 'element') return;
    for (const [k, v] of Object.entries(n.attrs)) if (/^data-(diagram-?name|diagramname)$/i.test(k) && v) names.add(v);
  });
  const decoded = String(rawHtml || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"');
  const re = /["']?diagramName["']?\s*[:=]\s*["']([^"'<>\n]{1,200})["']/g;
  let m;
  while ((m = re.exec(decoded))) names.add(m[1].trim());
  return [...names].filter(Boolean);
}

/**
 * @param {string} html   contenu de page.html (fragment HTML rendu par Confluence)
 * @param {object} [meta] { id, title, spaceKey, version, updatedAt, ancestors, labels }
 */
function parseViewPage(html, meta = {}) {
  const doc = parseXml(html || '');
  const drawioNames = findDrawioNames(html, doc);
  const obsoleteFragments = removeElements(doc, isObsolete);
  removeElements(doc, (n) => ['script', 'style', 'noscript', 'template'].includes(n.name));

  // --- liens, pièces jointes, images, macros ---
  const pageLinks = [];
  const attachments = new Set();
  const images = [];
  const macros = [];
  const jiraKeys = new Set();
  let currentHeading = meta.title || '';

  walk(doc, (n) => {
    if (n.type !== 'element') return;
    const h = n.name.match(HEADING);
    if (h) currentHeading = textOf(n);
    const a = n.attrs;
    const resType = a['data-linked-resource-type'];

    if (n.name === 'a' && a.href) {
      const browse = a.href.match(/\/browse\/([A-Z][A-Z0-9]{1,15}-\d{1,7})/);
      if (browse) jiraKeys.add(browse[1]);
      if (resType === 'page' || /\/(display|pages|spaces)\//.test(a.href)) {
        if (resType === 'page' || a['data-linked-resource-id']) {
          pageLinks.push({ title: textOf(n) || null, pageId: a['data-linked-resource-id'] || null, spaceKey: a['data-linked-resource-container-key'] || meta.spaceKey || null, href: a.href });
        }
      } else if (resType === 'attachment' || /\/download\/attachments\//.test(a.href)) {
        const f = a['data-linked-resource-default-alias'] || fileFromUrl(a.href);
        if (f) attachments.add(f);
      }
    } else if (n.name === 'img') {
      if (hasClass(n, 'emoticon') || /\/images\/icons\//.test(a.src || '')) return;
      const src = a['data-image-src'] || a.src || null;
      const isAttachment = resType === 'attachment' || /\/download\/(attachments|thumbnails)\//.test(src || '');
      const filename = a['data-linked-resource-default-alias'] || (isAttachment ? fileFromUrl(src) : null);
      if (filename && isAttachment) attachments.add(filename);
      images.push(
        isAttachment
          ? { kind: 'attachment', filename, attachmentId: a['data-linked-resource-id'] || null, src, alt: a.alt || null, section: currentHeading }
          : { kind: 'url', url: src, alt: a.alt || null, section: currentHeading }
      );
    }

    if (a['data-jira-key']) jiraKeys.add(a['data-jira-key']);
    if (hasClass(n, 'jira-issue')) {
      const k = (a['data-jira-key'] || textOf(n)).match(JIRA_KEY);
      if (k) jiraKeys.add(k[1]);
    }
    const macroName = a['data-macro-name'];
    if (macroName) macros.push({ name: macroName.toLowerCase(), params: {} });
  });

  const diagrams = drawioNames.map((name) => ({ type: 'drawio', name, pageId: meta.id || null }));

  // --- sections + tableaux, dans l'ordre du document ---
  const sections = [];
  const tables = [];
  let current = { heading: meta.title || '', level: 0, anchor: null, parts: [] };
  const flush = () => {
    const text = current.parts
      .join(' ')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
    if (text) sections.push({ heading: current.heading, level: current.level, anchor: current.anchor, text });
  };

  walk(doc, (n) => {
    if (n.type === 'text') {
      current.parts.push(n.value);
      return;
    }
    const h = n.name.match(HEADING);
    if (h) {
      flush();
      current = { heading: textOf(n), level: Number(h[1]), anchor: n.attrs.id || null, parts: [] };
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
    if (['p', 'li', 'br', 'div', 'tr', 'pre', 'blockquote', 'dd', 'dt'].includes(n.name)) current.parts.push('\n');
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

/**
 * Le HTML rendu perd les paramètres des macros : si le storage est disponible, on lui reprend
 * les diagrammes, macros, liens de pages et tickets Jira (le texte reste celui du rendu,
 * qui contient aussi le contenu des inclusions).
 */
function mergeStorageMacros(viewPage, storagePage) {
  if (!storagePage) return viewPage;
  const byName = new Map();
  for (const d of [...viewPage.diagrams, ...storagePage.diagrams]) if (d.name) byName.set(`${d.type}:${d.name}`, d);
  return {
    ...viewPage,
    diagrams: [...byName.values()],
    macros: storagePage.macros.length ? storagePage.macros : viewPage.macros,
    jiraKeys: [...new Set([...viewPage.jiraKeys, ...storagePage.jiraKeys])],
    pageLinks: storagePage.pageLinks.length ? storagePage.pageLinks : viewPage.pageLinks,
    attachments: [...new Set([...viewPage.attachments, ...storagePage.attachments])],
  };
}

module.exports = { parseViewPage, mergeStorageMacros, findDrawioNames };
