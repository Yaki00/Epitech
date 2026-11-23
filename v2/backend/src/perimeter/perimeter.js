'use strict';
/**
 * Périmètre d'analyse : la liste fermée des applications suivies (config/perimeter.json).
 *
 * Dans les exports d'inventaire et dans les noms rendus par la lecture IA des pages, une
 * application du périmètre peut être écrite autrement que son nom de référence : abrégée,
 * incomplète, en sigle, avec une faute. Ce module ramène un tel nom à l'application du périmètre
 * (il ne repère rien dans le texte des pages : c'est la lecture IA qui dit de quoi parle une page).
 *
 * Tout ce qui est hors périmètre est ignoré (ignoreOtherApplications, vrai par défaut).
 */
const fs = require('fs');
const { sha256 } = require('../lib/hash');
const { isInactiveEdge } = require('../graph/impact');
const { DOC_SOURCES } = require('../reading/verify');

/** "Order-Hub (PROD)" -> "order hub prod" : minuscules, sans accents, mots séparés par un espace. */
function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const compact = (s) => normalize(s).replace(/ /g, '');

/** Distance de Damerau-Levenshtein (inversion de 2 lettres = 1 faute), arrêtée dès que max est dépassé. */
function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

// scores d'une mention selon la façon dont elle a été reconnue
const SCORE = { exact: 1, alias: 1, colle: 0.95, auid: 0.9, sigle: 0.7, faute: 0.75, partiel: 0.6 };
const FUZZY_MIN = 5; // pas de recherche de faute sous 5 lettres : trop de faux positifs

/**
 * Lit config/perimeter.json. Absent = pas de périmètre (tout est analysé, comportement d'origine).
 * @returns {null | {applications: Array<{name, aliases, auid, naemonHostgroups}>, ignoreOtherApplications: boolean, hash: string}}
 */
function loadPerimeter(file) {
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const applications = (raw.applications || [])
    .map((a) => (typeof a === 'string' ? { name: a } : a))
    .filter((a) => a && String(a.name || '').trim())
    .map((a) => ({
      name: String(a.name).trim(),
      aliases: (a.aliases || []).map((x) => String(x).trim()).filter(Boolean),
      auid: a.auid ? String(a.auid).trim() : null,
      // groupes d'hôtes Naemon propres à l'application (facultatif)
      naemonHostgroups: Array.isArray(a.naemonHostgroups) ? a.naemonHostgroups.map((x) => String(x).trim()).filter(Boolean) : [],
    }));
  if (!applications.length) throw new Error(`${file} : aucune application dans "applications"`);
  return {
    applications,
    ignoreOtherApplications: raw.ignoreOtherApplications !== false,
    // changer la liste relance la lecture des pages. naemonHostgroups n'influence pas la lecture : hors du hash.
    // Le second élément (null) est gardé pour que l'empreinte reste celle de la v1 (ancienne liste de mots-clés,
    // retirée) : un perimeter.json inchangé ne change pas d'empreinte.
    hash: sha256(JSON.stringify([applications.map(({ naemonHostgroups, ...rest }) => rest), null])).slice(0, 12),
  };
}

/** Sigle d'un nom en plusieurs mots : "Gestion Commerciale Entreprises" -> "gce". */
function acronym(name) {
  const words = normalize(name).split(' ').filter(Boolean);
  return words.length >= 3 ? words.map((w) => w[0]).join('') : null;
}

/**
 * Prépare la reconnaissance des applications du périmètre.
 * @param {object} perimeter résultat de loadPerimeter
 * @param {object} [repo]    graphe : sert à connaître les serveurs et l'AUID de chaque application (import APM fait avant)
 */
function createMatcher(perimeter, repo = null) {
  const { nodeKey } = require('../store/repo');
  const apps = perimeter.applications.map((a) => {
    const id = `application:${nodeKey('application', a.name)}`;
    const node = repo ? repo.getNode(id) : null;
    const auid = a.auid || node?.attrs?.auid || null;
    const variants = [{ text: a.name, kind: 'exact' }, ...a.aliases.map((text) => ({ text, kind: 'alias' }))].map((v) => {
      const norm = normalize(v.text);
      return { ...v, norm, compact: norm.replace(/ /g, ''), words: norm.split(' ').filter(Boolean) };
    });
    // serveurs de référence : liens des inventaires seulement (un serveur ajouté par une lecture de page n'est pas
    // une référence, sinon le contrôle d'architecture changerait d'un passage à l'autre)
    const servers = new Set(repo ? repo.edgesFrom(id).filter((e) => e.type === 'runs_on' && !DOC_SOURCES.has(e.source) && !isInactiveEdge(e)).map((e) => e.dst) : []);
    return { id, name: a.name, auid, auidNorm: auid ? compact(auid) : null, variants, sigle: acronym(a.name), servers, naemonHostgroups: a.naemonHostgroups || [] };
  });
  const maxWords = Math.max(...apps.flatMap((a) => a.variants.map((v) => v.words.length))) + 1;
  const auidCount = new Map();
  for (const a of apps) if (a.auidNorm) auidCount.set(a.auidNorm, (auidCount.get(a.auidNorm) || 0) + 1);

  /**
   * Reconnaît un nom isolé (cellule d'export, nom renvoyé par l'IA, libellé de schéma).
   * @param {string} text
   * @param {{minScore?: number}} [opt] minScore 0.95 = exact, alias ou mots collés seulement
   * @returns {null | {app, kind, score, found}}
   */
  function matchName(text, { minScore = 0.75 } = {}) {
    const norm = normalize(text);
    if (!norm) return null;
    const c = norm.replace(/ /g, '');
    let best = null;
    const take = (app, kind) => {
      const score = SCORE[kind];
      if (score >= minScore && (!best || score > best.score)) best = { app, kind, score, found: String(text).trim() };
    };
    for (const app of apps) {
      for (const v of app.variants) {
        if (norm === v.norm) take(app, v.kind);
        else if (c === v.compact && c.length >= 4) take(app, 'colle');
        else if (c.length >= FUZZY_MIN && v.compact.length >= FUZZY_MIN && c[0] === v.compact[0] && editDistance(c, v.compact, v.compact.length >= 9 ? 2 : 1) <= (v.compact.length >= 9 ? 2 : 1))
          take(app, 'faute');
      }
      if (app.auidNorm && c === app.auidNorm) take(app, 'auid');
      if (app.sigle && c === app.sigle) take(app, 'sigle');
    }
    return best;
  }

  /**
   * Cherche les applications du périmètre citées dans un texte libre.
   * @returns {Map<appId, Array<{kind, score, found}>>}
   */
  function scanText(text) {
    // "_" fait partie du mot : ORA_BILL ou srv_bill_01 ne contiennent pas le sigle BILL
    const tokens = String(text || '').match(/[\p{L}\p{N}_]+/gu) || [];
    const norms = tokens.map((t) => normalize(t));
    const hits = new Map();
    const seen = new Set();
    const add = (app, kind, found) => {
      const k = `${app.id}|${kind}|${found.toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      if (!hits.has(app.id)) hits.set(app.id, []);
      hits.get(app.id).push({ kind, score: SCORE[kind], found });
    };
    const isUpper = (t) => t === t.toUpperCase() && /\p{L}/u.test(t);

    for (let i = 0; i < tokens.length; i++) {
      for (let n = 1; n <= maxWords && i + n <= tokens.length; n++) {
        const gramNorm = norms.slice(i, i + n).join(' ');
        const gramCompact = gramNorm.replace(/ /g, '');
        const found = tokens.slice(i, i + n).join(' ');
        for (const app of apps) {
          for (const v of app.variants) {
            if (gramNorm === v.norm) {
              // un nom très court (sigle de 2-3 lettres) n'est retenu qu'écrit en majuscules
              if (v.compact.length > 3 || (n === 1 && isUpper(tokens[i]))) add(app, v.kind, found);
            } else if (n > 1 && gramCompact === v.compact && v.compact.length >= 4) add(app, 'colle', found);
            else if (n === v.words.length && gramCompact.length >= FUZZY_MIN && v.compact.length >= FUZZY_MIN && gramCompact[0] === v.compact[0]) {
              const max = v.compact.length >= 9 ? 2 : 1;
              if (editDistance(gramCompact, v.compact, max) <= max) add(app, 'faute', found);
            } else if (v.words.length >= 2 && n < v.words.length && gramNorm === v.words.slice(0, n).join(' ') && norms[i + n] !== v.words[n]) {
              // nom incomplet (et pas le début du nom complet) : au moins 2 mots. Un seul mot ("Batch", "Gestion",
              // "Portail"…) est trop courant : il passe par un alias déclaré ou par la lecture IA.
              if (n >= 2) add(app, 'partiel', found);
            }
          }
          if (n === 1 && app.sigle && norms[i] === app.sigle && isUpper(tokens[i])) add(app, 'sigle', found);
          // un AUID comme "AUID-0042" est découpé en plusieurs mots : on compare la forme collée
          if (app.auidNorm && gramCompact === app.auidNorm) add(app, 'auid', found);
        }
      }
    }
    // un AUID partagé par plusieurs applications ne désigne aucune d'elles en particulier
    for (const list of hits.values()) for (const h of list) if (h.kind === 'auid' && auidCount.get(compact(h.found)) > 1) h.score = 0.6;
    return hits;
  }

  /**
   * Nom renvoyé par l'IA ou lu dans un schéma : "OrderHub (ORH)", "le batch ORH"…
   * Nom entier d'abord, sinon recherche dans le texte si UNE seule application y est reconnue.
   */
  function resolveAppName(text, { minScore = 0.75 } = {}) {
    const direct = matchName(text, { minScore });
    if (direct) return direct;
    const hits = [...scanText(text).entries()]
      .map(([id, list]) => ({ id, best: list.reduce((a, b) => (b.score > a.score ? b : a)) }))
      .filter((h) => h.best.score >= minScore);
    if (hits.length !== 1) return null;
    const app = apps.find((a) => a.id === hits[0].id);
    return { app, kind: hits[0].best.kind, score: hits[0].best.score, found: hits[0].best.found };
  }

  return { apps, matchName, resolveAppName, scanText, ignoreOthers: perimeter.ignoreOtherApplications, hash: perimeter.hash };
}

/**
 * Crée (ou met à jour) les nœuds des applications du périmètre, marqués perimeter = true,
 * avec leurs variantes en alias : la recherche et les schémas les retrouvent aussi.
 */
function ensurePerimeterNodes(repo, perimeter) {
  for (const a of perimeter.applications) {
    const attrs = { perimeter: true };
    if (a.auid) attrs.auid = a.auid;
    repo.upsertNode({ type: 'application', key: a.name, name: a.name, attrs, source: 'perimeter', aliases: a.aliases });
  }
}

module.exports = { loadPerimeter, createMatcher, ensurePerimeterNodes, normalize, editDistance, acronym, SCORE };
