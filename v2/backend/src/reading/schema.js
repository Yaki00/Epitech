'use strict';
/**
 * Forme de la lecture IA d'une page (type `Reading`) et nettoyage de ce que rend le modèle.
 * Le code ne repère rien ici : il garde les valeurs autorisées, écarte ce qui n'a pas de
 * citation, fusionne les doublons et retire les adresses électroniques et les numéros de
 * téléphone (les personnes ne sont gardées qu'avec leur nom, leur rôle et leur application).
 *
 * Reading = {
 *   page: { kind, period, env, topics[] },
 *   applications: [{ name, written, role, evidence }],
 *   entities: [{ name, type, env, status, evidence }],
 *   links: [{ from, to, type, evidence }],
 *   owners: [{ name, kind, application, role, evidence }],
 * }
 * `page.period` et `entities[].status` valent null quand le modèle a rendu une valeur non vide
 * mais méconnaissable : null veut dire « non fiable » (traité ensuite comme « à valider », hors
 * impact). Absents ou vides, ils valent `current` et `active`.
 */
const { SECTIONS } = require('../perimeter/architecture');
const { normalizeEnv } = require('../lib/environment');
const { isIPv4 } = require('../resolve/entities');

const KINDS = ['architecture', 'operations', 'install', 'incident', 'release', 'meeting', 'project', 'other'];
const PERIODS = ['current', 'past', 'target'];
const ENVS = ['PRD', 'STG', 'DEV'];
const TOPICS = Object.keys(SECTIONS);
const APP_ROLES = ['subject', 'cited'];
const ENTITY_TYPES = ['server', 'ip', 'database', 'url', 'queue', 'path', 'person', 'team'];
const STATUSES = ['active', 'decommissioned', 'planned'];
const LINK_TYPES = ['runs_on', 'uses_db', 'db_on', 'calls', 'reads_from', 'writes_to', 'depends_on'];
const OWNER_KINDS = ['person', 'team'];
const OWNER_ROLES = ['owner', 'support', 'oncall', 'other'];
const EVIDENCE_MAX = 300;

/** Contrôle de forme passé à llm.chatJson (une réponse sans `page` est renvoyée au modèle). */
const READING_SCHEMA = { page: 'object', 'applications?': 'array', 'entities?': 'array', 'links?': 'array', 'owners?': 'array' };

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '');
/** Valeur facultative : « null » écrit en texte par le modèle vaut absence. */
const opt = (v) => (/^(null|none|n\/a)$/i.test(str(v)) ? '' : str(v));
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
/** Clé de comparaison des noms : casse, accents et espaces ignorés. */
const normKey = (s) =>
  str(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
/** Clé de comparaison des valeurs de liste : casse, accents, espaces, tirets et soulignés ignorés. */
const fold = (s) => normKey(s).replace(/[\s_-]+/g, '');

/**
 * Traductions évidentes des valeurs de liste (le modèle répond parfois en français) : c'est une
 * remise en forme des valeurs attendues, pas un repérage dans le texte des pages.
 */
const ALIASES = {
  kind: {
    exploitation: 'operations',
    installation: 'install',
    version: 'release',
    miseenproduction: 'release',
    reunion: 'meeting',
    projet: 'project',
    autre: 'other',
  },
  period: {
    ancienne: 'past',
    ancien: 'past',
    historique: 'past',
    obsolete: 'past',
    passe: 'past',
    passee: 'past',
    cible: 'target',
    futur: 'target',
    future: 'target',
    prevu: 'target',
    prevue: 'target',
    projet: 'target',
    actuelle: 'current',
    actuel: 'current',
    courante: 'current',
    courant: 'current',
    encours: 'current',
  },
  status: {
    actif: 'active',
    enservice: 'active',
    enproduction: 'active',
    decommissionne: 'decommissioned',
    arrete: 'decommissioned',
    supprime: 'decommissioned',
    retire: 'decommissioned',
    prevu: 'planned',
    avenir: 'planned',
    planifie: 'planned',
  },
  appRole: { sujet: 'subject', principal: 'subject', cite: 'cited', citee: 'cited', mentionne: 'cited', mentionnee: 'cited' },
  ownerRole: { responsable: 'owner', astreinte: 'oncall', autre: 'other' },
  env: { recette: 'STG', uat: 'STG' },
};

/**
 * Valeur de liste : valeur attendue ou sa traduction ; `empty` si absente ou vide (ou « null »),
 * `unknown` si non vide et méconnaissable.
 */
const pick = (v, allowed, { aliases = {}, empty = null, unknown = empty } = {}) => {
  const s = opt(v);
  if (!s) return empty;
  const f = fold(s);
  return allowed.find((a) => fold(a) === f) || aliases[f] || unknown;
};
/** Environnement : PRD, STG, DEV, synonymes connus (dont ceux de mappings.json) ou null. */
const envOf = (v) => {
  const s = opt(v);
  return s ? normalizeEnv(s) || ALIASES.env[fold(s)] || null : null;
};

// ---------- données personnelles ----------
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_CANDIDATE = /\+?\d[\d\s.()-]{6,}\d/g;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const isPhone = (s) => (s.match(/\d/g) || []).length >= 9 && !IPV4.test(s.trim());
const EDGE_PUNCT = /^[\s,;:()[\]<>/|.-]+|[\s,;:([<>/|-]+$/g;

/** Coupe `s` autour des adresses (et des numéros si `phones`) : morceaux tels quels du texte. */
function splitPersonal(s, phones) {
  let marked = s.replace(EMAIL, '\u0000');
  if (phones) marked = marked.replace(PHONE_CANDIDATE, (m) => (isPhone(m) ? '\u0000' : m));
  return marked.split('\u0000');
}

/** Nom sans adresse ni numéro. */
function cleanName(s, phones) {
  return splitPersonal(s, phones)
    .join(' ')
    .replace(/\(\s*[,;\s]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCT, '')
    .trim();
}

/**
 * Citation sans adresse ni numéro : on garde le plus long morceau qui n'en contient pas, pour
 * qu'elle reste une suite exacte du texte de la page (vérifiée ensuite par le code).
 */
function cleanEvidence(v, phones) {
  const s = str(v).slice(0, EVIDENCE_MAX * 2);
  const parts = splitPersonal(s, phones);
  if (parts.length === 1) return s.slice(0, EVIDENCE_MAX).trim();
  const pieces = parts.map((p) => p.replace(EDGE_PUNCT, '').trim());
  const best = pieces.reduce((a, b) => (b.length > a.length ? b : a), '');
  return best.length >= 2 ? best.slice(0, EVIDENCE_MAX).trim() : '';
}

// ---------- fusion des doublons (une lecture, ou plusieurs morceaux d'une même page) ----------
/**
 * Règles de fusion (le premier élément vu donne nom, forme écrite et citation) :
 *  - application : `subject` l'emporte sur `cited` ;
 *  - entité (même nom et même type) : premier environnement connu ; un statut `decommissioned`
 *    ou `planned` l'emporte sur un statut non fiable (null), qui l'emporte sur `active` (prudence :
 *    un serveur dit arrêté ou prévu quelque part dans la page ne doit pas compter comme actif) ;
 *  - lien (même origine, type et destination) : le premier ;
 *  - responsable (même nom, sorte et application) : premier rôle autre que `other`.
 */
function mergeItems(items, keyOf, combine) {
  const byKey = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!byKey.has(k)) byKey.set(k, { ...it });
    else combine(byKey.get(k), it);
  }
  return [...byKey.values()];
}

const mergeApplications = (items) =>
  mergeItems(items, (a) => normKey(a.name), (kept, a) => {
    if (a.role === 'subject') kept.role = 'subject';
  });
/** Prudence : arrêté ou prévu, puis non fiable (null), puis actif. */
const statusRank = (st) => (st === 'active' ? 0 : st === null ? 1 : 2);
const mergeEntities = (items) =>
  mergeItems(items, (e) => `${e.type}|${normKey(e.name)}`, (kept, e) => {
    if (!kept.env && e.env) kept.env = e.env;
    if (!kept.ip && e.ip) kept.ip = e.ip;
    if (statusRank(e.status) > statusRank(kept.status)) kept.status = e.status;
  });
const mergeLinks = (items) => mergeItems(items, (l) => `${normKey(l.from)}|${l.type}|${normKey(l.to)}`, () => {});
const mergeOwners = (items) =>
  mergeItems(items, (o) => `${o.kind}|${normKey(o.name)}|${normKey(o.application)}`, (kept, o) => {
    if (kept.role === 'other' && o.role !== 'other') kept.role = o.role;
  });

// ---------- nettoyage ----------
function sanitizePage(p) {
  const page = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const topics = Array.isArray(page.topics) ? page.topics.map((t) => pick(t, TOPICS)).filter(Boolean) : [];
  return {
    kind: pick(page.kind, KINDS, { aliases: ALIASES.kind, empty: 'other' }),
    period: pick(page.period, PERIODS, { aliases: ALIASES.period, empty: 'current', unknown: null }),
    env: envOf(page.env),
    topics: [...new Set(topics)],
  };
}

function sanitizeReading(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const applications = list(r.applications)
    .map((a) => {
      const name = cleanName(str(a.name), false);
      return { name, written: cleanName(str(a.written), false) || name, role: pick(a.role, APP_ROLES, { aliases: ALIASES.appRole, empty: 'cited' }), evidence: cleanEvidence(a.evidence, false) };
    })
    .filter((a) => a.name && a.evidence);

  const entities = list(r.entities)
    .map((e) => {
      const type = pick(e.type, ENTITY_TYPES);
      const human = type === 'person' || type === 'team';
      const rawName = str(e.name);
      // une adresse électronique n'est jamais une entité ; une personne ou une équipe perd ses numéros
      const name = human ? cleanName(rawName, true) : rawName.replace(EMAIL, '') === rawName ? rawName : '';
      const ip = type === 'server' && typeof e.ip === 'string' && isIPv4(e.ip.trim()) ? e.ip.trim() : null;
      return { name, type, ip, env: envOf(e.env), status: pick(e.status, STATUSES, { aliases: ALIASES.status, empty: 'active', unknown: null }), evidence: cleanEvidence(e.evidence, human) };
    })
    .filter((e) => e.type && e.name && e.evidence);

  const links = list(r.links)
    .map((l) => ({ from: str(l.from), to: str(l.to), type: pick(l.type, LINK_TYPES), evidence: cleanEvidence(l.evidence, false) }))
    .filter((l) => l.from && l.to && l.type && l.evidence && normKey(l.from) !== normKey(l.to));

  const owners = list(r.owners)
    .map((o) => ({
      name: cleanName(str(o.name), true),
      kind: pick(o.kind, OWNER_KINDS),
      application: cleanName(opt(o.application), false) || null,
      role: pick(o.role, OWNER_ROLES, { aliases: ALIASES.ownerRole, empty: 'other' }),
      evidence: cleanEvidence(o.evidence, true),
    }))
    .filter((o) => o.name && o.kind && o.evidence);

  return {
    page: sanitizePage(r.page),
    applications: mergeApplications(applications),
    entities: mergeEntities(entities),
    links: mergeLinks(links),
    owners: mergeOwners(owners),
  };
}

/**
 * Fusion des lectures des morceaux d'une même page (chacune déjà nettoyée), dans l'ordre.
 * Page : la nature vient du premier morceau, sauf s'il a répondu `other` (le premier morceau
 * précis l'emporte) ; la période vient toujours du premier morceau, qui porte le titre et
 * l'introduction où une page se dit cible, obsolète ou historique (une section « Historique »
 * plus bas ne rend pas la page ancienne : le statut de chaque serveur le dit) ; si elle y est non
 * fiable (null), une période `past` ou `target` d'un morceau suivant est reprise, sinon elle reste
 * null (jamais `current` par défaut) ; l'environnement
 * est le premier connu ; les sujets sont réunis.
 */
/** Premier morceau non fiable : une période ancienne ou cible dite plus loin est reprise, sinon null. */
function periodAfterUnreliable(all) {
  const later = all.find((r) => r.page.period === 'past' || r.page.period === 'target');
  return later ? later.page.period : null;
}

function mergeReadings(readings) {
  const all = readings.filter(Boolean);
  if (!all.length) return sanitizeReading({});
  const first = all[0].page;
  const precise = all.find((r) => r.page.kind !== 'other');
  const withEnv = all.find((r) => r.page.env);
  return {
    page: {
      kind: precise ? precise.page.kind : first.kind,
      period: first.period !== null ? first.period : periodAfterUnreliable(all),
      env: withEnv ? withEnv.page.env : null,
      topics: [...new Set(all.flatMap((r) => r.page.topics))],
    },
    applications: mergeApplications(all.flatMap((r) => r.applications)),
    entities: mergeEntities(all.flatMap((r) => r.entities)),
    links: mergeLinks(all.flatMap((r) => r.links)),
    owners: mergeOwners(all.flatMap((r) => r.owners)),
  };
}

module.exports = {
  sanitizeReading,
  mergeReadings,
  normKey,
  READING_SCHEMA,
  KINDS,
  PERIODS,
  ENVS,
  TOPICS,
  APP_ROLES,
  ENTITY_TYPES,
  STATUSES,
  LINK_TYPES,
  OWNER_KINDS,
  OWNER_ROLES,
};
