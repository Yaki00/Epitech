'use strict';
/**
 * Recherche dans les fiches (et, en second recours, dans les sections de pages), aidée du graphe.
 *  - BM25 maison sur les mots de la fiche (titre et mots de recherche comptés deux fois) ;
 *  - mots techniques gardés entiers (Q.MRL.EVT, ORA-01555, lmrlp01) en plus de leurs morceaux ;
 *  - bonus selon l'application de la question et ses voisines, malus pour les procédures anciennes ou remplacées ;
 *  - à égalité (5 %), la fiche la plus récente d'abord.
 * L'index vit en mémoire : buildKnowledgeIndex le reconstruit après chaque rechargement du store.
 * Les fiches retirées (attrs.retired) ne sont jamais renvoyées.
 */
const { normalizeText } = require('../reading/evidence');
const { isInactiveEdge } = require('../graph/impact');

// ---- réglages ----
const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2; // titre et mots de recherche comptés deux fois
const OWN_APP_BONUS = 1.5; // fiche de l'application de la question
const NEIGHBOUR_BONUS = 1.2; // fiche d'une application voisine
const OLD_MALUS = 0.5; // procédure ou pratique ancienne
const REPLACED_MALUS = 0.3; // procédure remplacée
const TIE_WINDOW = 0.05; // à 5 % près, la plus récente d'abord
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_SECTION_HITS = 5;
const MAX_QUERY_TERMS = 80;
const MIN_APP_SCORE = 0.7; // confiance minimale d'une application reconnue dans la question (le sigle en majuscules compte)
const MAX_RESOLVE_TOKENS = 200;
const EXCERPT_LENGTH = 220;
const NEIGHBOUR_LINKS = ['calls', 'depends_on', 'reads_from', 'writes_to'];
const SHARED_LINKS = ['runs_on', 'uses_db', 'uses_queue', 'publishes_to', 'consumes_from'];
const SHARED_TARGETS = new Set(['server', 'database', 'queue']);
const AGING_KINDS = new Set(['procedure', 'pratique']);

const STOP = new Set(
  ('le la les un une des du de d l au aux et ou en dans sur sous pour par avec sans ce cet cette ces se sa son ses qui que quoi est sont ete etre a as ont il elle on ne pas plus ni si mais donc the of to and in on at is are was be for with from by an it this that').split(' ')
);

// ---- mots ----
const CANDIDATE = /[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?/gu;
const isTechnical = (t) => /[\p{N}._-]/u.test(t);
const stem = (w) => (w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w);

/** Mots d'un texte : mots simples normalisés, plus mots techniques entiers. */
function tokenize(text) {
  const out = [];
  const tech = [];
  for (const raw of normalizeText(text).match(CANDIDATE) || []) {
    if (isTechnical(raw)) tech.push(raw);
    for (const w of raw.split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 2 || STOP.has(w)) continue;
      out.push(stem(w));
    }
  }
  return { words: out, tech };
}

const itemTexts = (it) => (it && typeof it === 'object' ? [it.text, it.evidence] : [it]).filter(Boolean);

/** Textes d'une fiche, en deux lots : renforcés (titre, mots de recherche) et normaux. */
function ficheTexts(attrs) {
  const strong = [attrs.title, ...(attrs.keywords || [])];
  const normal = [attrs.section];
  for (const it of Object.values(attrs.fields || {})) normal.push(...itemTexts(it));
  for (const list of Object.values(attrs.lists || {})) for (const it of list || []) normal.push(...itemTexts(it));
  normal.push(...(attrs.tickets || []));
  return { strong: strong.filter(Boolean), normal: normal.filter(Boolean) };
}

/** Index BM25 sur une liste de documents { id, strong[], normal[] }. */
function bm25Index(docs) {
  const df = new Map();
  const list = docs.map((d) => {
    const tf = new Map();
    let len = 0;
    const add = (text, weight) => {
      const { words, tech } = tokenize(text);
      for (const t of [...words, ...tech]) {
        tf.set(t, (tf.get(t) || 0) + weight);
        len += weight;
      }
    };
    for (const t of d.strong) add(t, TITLE_WEIGHT);
    for (const t of d.normal) add(t, 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { id: d.id, tf, len };
  });
  const avg = list.length ? list.reduce((s, d) => s + d.len, 0) / list.length : 0;
  return { docs: list, df, avg, n: list.length };
}

function bm25Score(index, doc, terms) {
  let score = 0;
  for (const t of terms) {
    const f = doc.tf.get(t);
    if (!f) continue;
    const n = index.df.get(t) || 0;
    const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
    score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / (index.avg || 1)));
  }
  return score;
}

/** Mots de la question : techniques d'abord (jamais perdus dans une longue pile), puis les autres, sans doublon. */
function queryTerms(query, index) {
  const { words, tech } = tokenize(query);
  const known = (t) => !index || index.fiches.df.has(t) || index.sections.df.has(t);
  // seuls les mots présents dans l'index comptent : une longue pile ne noie pas le code d'erreur
  return [...new Set([...tech, ...words])].filter(known).slice(0, MAX_QUERY_TERMS);
}

/**
 * @param {object} repo
 * @param {{sections?: object[]}} [o] sections : contenu de knowledge-sections.json (facultatif)
 */
function buildKnowledgeIndex(repo, { sections = [] } = {}) {
  const fiches = repo.listByType('fiche').filter((n) => !n.attrs.retired);
  const secs = (Array.isArray(sections) ? sections : []).filter((s) => s && s.text);
  return {
    fiches: bm25Index(fiches.map((n) => ({ id: n.id, ...ficheTexts(n.attrs) }))),
    sections: bm25Index(secs.map((s) => ({ id: s, strong: [s.title, s.section].filter(Boolean), normal: [s.text] }))),
    sectionList: secs,
  };
}

// ---- graphe ----
const stamp = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
};

const ficheLinks = (repo, id) => repo.edgesFrom(id).filter((e) => e.type === 'concerne');
const appsOfServer = (repo, serverId) => repo.edgesTo(serverId).filter((e) => e.type === 'runs_on' && e.src.startsWith('application:')).map((e) => e.src);

/** Applications directement visées par la fiche, ou à défaut celles qui tournent sur ses serveurs. */
function appsOfFiche(repo, id) {
  const links = ficheLinks(repo, id);
  const direct = links.filter((e) => e.dst.startsWith('application:')).map((e) => e.dst);
  if (direct.length) return { apps: direct, servers: links.filter((e) => e.dst.startsWith('server:')).map((e) => e.dst) };
  const servers = links.filter((e) => e.dst.startsWith('server:')).map((e) => e.dst);
  return { apps: [...new Set(servers.flatMap((s) => appsOfServer(repo, s)))], servers };
}

/** Applications voisines : liens actifs d'appel ou de dépendance dans les deux sens, ou serveur, base, file partagés. */
function neighboursOf(repo, appId) {
  const out = new Set();
  const isApp = (id) => id.startsWith('application:') && id !== appId;
  const active = (e) => !isInactiveEdge(e);
  for (const e of repo.edgesFrom(appId).filter(active)) {
    if (NEIGHBOUR_LINKS.includes(e.type) && isApp(e.dst)) out.add(e.dst);
    if (SHARED_LINKS.includes(e.type)) {
      const t = repo.getNode(e.dst);
      if (t && SHARED_TARGETS.has(t.type)) {
        for (const o of repo.edgesTo(e.dst).filter(active)) if (SHARED_LINKS.includes(o.type) && isApp(o.src)) out.add(o.src);
      }
    }
  }
  for (const e of repo.edgesTo(appId).filter(active)) if (NEIGHBOUR_LINKS.includes(e.type) && isApp(e.src)) out.add(e.src);
  return out;
}

/** Applications (et serveurs) de la question : matcher, noms résolus dans le graphe, argument explicite. */
function questionTargets(repo, matcher, query, application) {
  const apps = new Set();
  const servers = new Set();
  const take = (n) => {
    if (!n) return;
    if (n.type === 'application') apps.add(n.id);
    else if (n.type === 'server') servers.add(n.id);
  };
  if (application) {
    const a = String(application).trim();
    const byId = repo.getNode(a);
    if (byId && byId.type === 'application') apps.add(byId.id);
    else {
      for (const n of repo.resolve(a)) take(n);
      const m = matcher && matcher.matchName ? matcher.matchName(a) : null;
      if (m && m.app) apps.add(m.app.id);
    }
  }
  if (matcher && matcher.scanText) {
    for (const [id, hits] of matcher.scanText(query)) if (hits.some((h) => h.score >= MIN_APP_SCORE) && repo.getNode(id)) apps.add(id);
  }
  const tokens = [...new Set((String(query).match(/[\p{L}\p{N}._-]{3,}/gu) || []))].slice(0, MAX_RESOLVE_TOKENS);
  for (const t of tokens) for (const n of repo.resolve(t)) take(n);
  return { apps, servers };
}

function excerptOf(text, terms) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= EXCERPT_LENGTH) return clean;
  const norm = normalizeText(clean);
  let at = -1;
  // la normalisation peut changer la longueur : on ne s'en sert que si elle la conserve
  if (norm.length === clean.length) for (const t of terms) { const i = norm.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = at < 0 ? 0 : Math.max(0, at - 60);
  return `${start ? '...' : ''}${clean.slice(start, start + EXCERPT_LENGTH)}${start + EXCERPT_LENGTH < clean.length ? '...' : ''}`;
}

function ficheExcerpt(attrs, terms) {
  const texts = [];
  for (const it of Object.values(attrs.fields || {})) if (it && it.text) texts.push(it.evidence && it.evidence.length > it.text.length ? it.evidence : it.text);
  for (const list of Object.values(attrs.lists || {})) for (const it of list || []) if (it && it.text) texts.push(it.text);
  const has = (t) => { const n = normalizeText(t); return terms.some((x) => n.includes(x)); };
  const best = texts.find(has) || texts[0] || attrs.title || '';
  return excerptOf(best, terms);
}

const isOld = (attrs) => AGING_KINDS.has(attrs.kind) && attrs.period === 'past';

/** Par blocs de scores voisins (5 %), la plus récente d'abord dans chaque bloc. */
function orderWithTies(hits) {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    const top = sorted[i].score;
    const bucket = [];
    while (i < sorted.length && sorted[i].score >= top * (1 - TIE_WINDOW)) bucket.push(sorted[i++]);
    bucket.sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || b.score - a.score);
    out.push(...bucket);
  }
  return out;
}

/**
 * @returns {{fiches: Hit[], sections: SectionHit[], apps: string[]}} apps : identifiants des applications reconnues dans la question
 */
function searchKnowledge(index, repo, matcher, { query, application, limit = DEFAULT_LIMIT } = {}) {
  const q = String(query || '');
  const terms = queryTerms(q, index);
  const target = questionTargets(repo, matcher, q, application);
  if (!index || !terms.length) return { fiches: [], sections: [], apps: [...target.apps] };
  const max = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const neighbours = new Set();
  for (const a of target.apps) for (const n of neighboursOf(repo, a)) neighbours.add(n);

  const hits = [];
  for (const doc of index.fiches.docs) {
    const raw = bm25Score(index.fiches, doc, terms);
    if (raw <= 0) continue;
    const node = repo.getNode(doc.id);
    if (!node || node.attrs.retired) continue;
    const a = node.attrs;
    const { apps, servers } = appsOfFiche(repo, doc.id);
    const own = apps.some((x) => target.apps.has(x)) || servers.some((s) => target.servers.has(s));
    const near = !own && apps.some((x) => neighbours.has(x));
    const old = isOld(a);
    const replaced = Boolean(a.replacedBy);
    let score = raw * (own ? OWN_APP_BONUS : near ? NEIGHBOUR_BONUS : 1);
    if (old) score *= OLD_MALUS;
    if (replaced) score *= REPLACED_MALUS;
    hits.push({
      id: node.id,
      kind: a.kind,
      title: a.title,
      appNames: apps.map((x) => (repo.getNode(x) || {}).name).filter(Boolean),
      period: a.period || null,
      updatedAt: a.updatedAt || null,
      url: a.url || null,
      section: a.section || null,
      excerpt: ficheExcerpt(a, terms),
      score: Math.round(score * 1000) / 1000,
      old,
      replaced,
      otherApplication: target.apps.size > 0 && apps.length > 0 && !apps.some((x) => target.apps.has(x)),
    });
  }
  const fiches = orderWithTies(hits).slice(0, max);

  // sections de pages : second recours, sans doublon avec une fiche déjà rendue
  const seen = new Set(fiches.filter((f) => f.section).map((f) => `${f.url && f.url.split('#')[0]}|${normalizeText(f.section)}`));
  const sections = [];
  const scored = index.sections.docs
    .map((d) => ({ d, s: bm25Score(index.sections, d, terms) * (d.id.period === 'past' ? OLD_MALUS : 1) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  for (const { d, s } of scored) {
    const sec = d.id;
    if (seen.has(`${String(sec.url || '').split('#')[0]}|${normalizeText(sec.section || '')}`) && sec.section) continue;
    sections.push({ pageId: sec.pageId, title: sec.title, section: sec.section || null, url: sec.url || null, period: sec.period || null, old: sec.period === 'past', excerpt: excerptOf(sec.text, terms), score: Math.round(s * 1000) / 1000 });
    if (sections.length >= MAX_SECTION_HITS) break;
  }
  return { fiches, sections, apps: [...target.apps] };
}

/** Fiche complète (citations comprises), ou null si inconnue, retirée ou d'un autre type. */
function getFiche(repo, id) {
  const n = repo.getNode(String(id || ''));
  if (!n || n.type !== 'fiche' || n.attrs.retired) return null;
  const a = n.attrs;
  const { apps } = appsOfFiche(repo, n.id);
  return {
    id: n.id,
    kind: a.kind,
    title: a.title,
    section: a.section || null,
    url: a.url || null,
    appNames: apps.map((x) => (repo.getNode(x) || {}).name).filter(Boolean),
    period: a.period || null,
    updatedAt: a.updatedAt || null,
    date: a.date || null,
    old: isOld(a),
    replaced: Boolean(a.replacedBy),
    replacedBy: a.replacedBy || null,
    fields: a.fields || {},
    lists: a.lists || {},
    tickets: a.tickets || [],
    keywords: a.keywords || [],
  };
}

/** Fiches (non retirées) qui concernent une application, plus récentes d'abord : pour la fiche détail de l'application. */
function ficheSummariesOf(repo, appId) {
  const out = [];
  for (const e of repo.edgesTo(appId)) {
    if (e.type !== 'concerne') continue;
    const n = repo.getNode(e.src);
    if (!n || n.type !== 'fiche' || n.attrs.retired) continue;
    out.push({ id: n.id, kind: n.attrs.kind, title: n.attrs.title, period: n.attrs.period || null, updatedAt: n.attrs.updatedAt || null, url: n.attrs.url || null, old: isOld(n.attrs), replaced: Boolean(n.attrs.replacedBy) });
  }
  return out.sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || (a.id < b.id ? -1 : 1));
}

module.exports = { buildKnowledgeIndex, searchKnowledge, getFiche, ficheSummariesOf, tokenize };
