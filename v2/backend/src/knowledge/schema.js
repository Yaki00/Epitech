'use strict';
/**
 * Forme de la lecture IA d'une fiche opérationnelle (type `FicheReading`) et nettoyage de ce que
 * rend le modèle. Comme pour la lecture des pages : le code garde les valeurs autorisées, écarte
 * tout élément sans citation, fusionne les doublons et retire adresses électroniques et numéros.
 *
 * Item = { text, evidence }
 * FicheReading = {
 *   kind, title: Item, section: string|null, date: Item|null,
 *   fields: { [nom]: Item }, lists: { [nom]: Item[] },
 *   apps: Item[], servers: Item[], keywords: string[], replaces: Item|null, fixes: Item|null,
 * }
 */
const { str, opt, list, cleanName, cleanEvidence, normKey } = require('../reading/schema');

const FICHE_KINDS = ['incident', 'correctif', 'procedure', 'pratique'];
/** Natures de page qui reçoivent la lecture des fiches. */
const OPS_KINDS = ['incident', 'release', 'operations', 'install', 'other'];
/** Version de la lecture des fiches : à augmenter quand les consignes ou la forme changent. */
const OPS_VERSION = 1;

/** Champs (texte) et listes autorisés, par type de fiche. */
const FICHE_SHAPE = {
  incident: { fields: ['symptoms', 'cause', 'solution'], lists: ['errors', 'actions', 'tickets'] },
  correctif: { fields: ['version'], lists: ['tickets'] },
  procedure: { fields: ['goal', 'when', 'prerequisites', 'cautions'], lists: ['steps'] },
  pratique: { fields: [], lists: ['rules'] },
};

const FICHES_SCHEMA = { fiches: 'array' };
const KEYWORDS_MAX = 12;
const KEYWORD_LEN = 60;
const TEXT_MAX = 1500;
const SECTION_MAX = 150;

/** Élément { text, evidence } : null sans texte ou sans citation (une fois adresses et numéros retirés). */
function cleanItem(v) {
  if (typeof v === 'string' || !v || typeof v !== 'object') return null;
  const text = cleanName(opt(v.text), true).slice(0, TEXT_MAX).trim();
  const evidence = cleanEvidence(opt(v.evidence), true);
  return text && evidence ? { text, evidence } : null;
}

const itemsOf = (v) => list(v).map(cleanItem).filter(Boolean);

function uniqueItems(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = normKey(it.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cleanKeywords(v) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(v) ? v : []) {
    const s = cleanName(opt(k), true);
    const key = normKey(s);
    if (!s || s.length > KEYWORD_LEN || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= KEYWORDS_MAX) break;
  }
  return out;
}

function sanitizeFiche(f) {
  if (!f || typeof f !== 'object') return null;
  const kind = normKey(f.kind);
  if (!FICHE_KINDS.includes(kind)) return null;
  const title = cleanItem(f.title);
  if (!title) return null;
  const shape = FICHE_SHAPE[kind];
  const rawFields = f.fields && typeof f.fields === 'object' ? f.fields : {};
  const rawLists = f.lists && typeof f.lists === 'object' ? f.lists : {};
  const fields = {};
  for (const name of shape.fields) {
    const it = cleanItem(rawFields[name]);
    if (it) fields[name] = it;
  }
  const lists = {};
  for (const name of shape.lists) lists[name] = itemsOf(rawLists[name]);
  const section = cleanName(opt(f.section), true).slice(0, SECTION_MAX).trim();
  return {
    kind,
    title,
    section: section || null,
    date: cleanItem(f.date),
    fields,
    lists,
    apps: uniqueItems(itemsOf(f.apps)),
    servers: uniqueItems(itemsOf(f.servers)),
    keywords: cleanKeywords(f.keywords),
    replaces: cleanItem(f.replaces),
    fixes: cleanItem(f.fixes),
  };
}

/** Réponse brute du modèle vers { fiches }. */
function sanitizeFiches(raw) {
  const fiches = list(raw && raw.fiches).map(sanitizeFiche).filter(Boolean);
  return { fiches };
}

/** Fusionne b dans a (même type, même titre) : premier champ vu, listes concaténées sans doublon. */
function combine(a, b) {
  for (const [name, it] of Object.entries(b.fields)) if (!a.fields[name]) a.fields[name] = it;
  for (const [name, items] of Object.entries(b.lists)) a.lists[name] = uniqueItems([...(a.lists[name] || []), ...items]);
  a.apps = uniqueItems([...a.apps, ...b.apps]);
  a.servers = uniqueItems([...a.servers, ...b.servers]);
  a.keywords = cleanKeywords([...a.keywords, ...b.keywords]);
  a.section = a.section || b.section;
  a.date = a.date || b.date;
  a.replaces = a.replaces || b.replaces;
  a.fixes = a.fixes || b.fixes;
}

/** Concatène les fiches des morceaux d'une page ; même type et même titre normalisé : une seule fiche. */
function mergeFicheReadings(readings) {
  const byKey = new Map();
  for (const r of readings || []) {
    for (const f of (r && r.fiches) || []) {
      const key = `${f.kind}\u0000${normKey(f.title.text)}`;
      if (!byKey.has(key)) byKey.set(key, { ...f, fields: { ...f.fields }, lists: { ...f.lists } });
      else combine(byKey.get(key), f);
    }
  }
  return { fiches: [...byKey.values()] };
}

module.exports = { sanitizeFiches, mergeFicheReadings, FICHE_KINDS, OPS_KINDS, OPS_VERSION, FICHE_SHAPE, FICHES_SCHEMA };
