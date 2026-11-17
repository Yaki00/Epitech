'use strict';
/**
 * Mini parseur XML/XHTML tolérant, sans dépendance.
 * Suffisant pour le format "storage" de Confluence (XHTML + balises ac:/ri:)
 * et pour le XML draw.io. Produit un arbre simple :
 *   { type:'element', name, attrs, children } | { type:'text', value }
 */

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', euro: '€', deg: '°', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', acirc: 'â', icirc: 'î', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', euml: 'ë', iuml: 'ï', oelig: 'œ', times: '×', rarr: '→', larr: '←', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([\w:.-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function parseXml(input) {
  const root = { type: 'element', name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/gi;
  let last = 0;
  let m;
  const pushText = (t) => {
    if (t) top().children.push({ type: 'text', value: t });
  };
  while ((m = re.exec(input))) {
    pushText(decodeEntities(input.slice(last, m.index)));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      top().children.push({ type: 'text', value: m[1], cdata: true });
      continue;
    }
    const [, , closing, rawName, attrSrc, selfClose] = m;
    if (!rawName) continue; // commentaire, PI, doctype
    const name = rawName.toLowerCase();
    if (closing) {
      // ferme jusqu'à la balise correspondante (tolère les balises mal fermées)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el = { type: 'element', name, attrs: parseAttrs(attrSrc), children: [] };
    top().children.push(el);
    if (!selfClose && !VOID.has(name)) stack.push(el);
  }
  pushText(decodeEntities(input.slice(last)));
  return root;
}

/** Parcours en profondeur. */
function walk(node, fn, parents = []) {
  if (fn(node, parents) === false) return;
  if (node.children) for (const c of node.children) walk(c, fn, [...parents, node]);
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (n) => {
    if (n.type === 'element' && predicate(n)) out.push(n);
  });
  return out;
}

const byName = (name) => (n) => n.name === name;

/** Texte brut d'un nœud, avec espaces normalisés. Les CDATA (code) sont inclus. */
function textOf(node) {
  const parts = [];
  walk(node, (n) => {
    if (n.type === 'text') parts.push(n.value);
    else if (n.type === 'element' && ['br', 'p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'div'].includes(n.name)) parts.push(' ');
  });
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Retire de l'arbre les éléments qui vérifient `predicate` (avec tout leur contenu).
 * @returns {number} nombre d'éléments retirés
 */
function removeElements(node, predicate) {
  let removed = 0;
  if (!node.children) return 0;
  node.children = node.children.filter((c) => {
    if (c.type === 'element' && predicate(c)) {
      removed++;
      return false;
    }
    return true;
  });
  for (const c of node.children) removed += removeElements(c, predicate);
  return removed;
}

/** Texte barré (<s>, <del>, <strike>, style line-through) : dans la doc d'infra, c'est de l'obsolète. */
const isObsolete = (n) => ['s', 'del', 'strike'].includes(n.name) || /line-through/i.test(n.attrs.style || '');

module.exports = { parseXml, walk, findAll, byName, textOf, decodeEntities, removeElements, isObsolete };
