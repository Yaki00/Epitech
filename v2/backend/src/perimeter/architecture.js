'use strict';
/**
 * Contrôle des pages d'architecture par rapport aux inventaires (APM, marketplace).
 *
 * Qu'une page soit une page d'architecture, son environnement, les serveurs qu'elle cite et les
 * rubriques qu'elle couvre viennent de la lecture IA vérifiée (src/reading/). Ce module compare
 * seulement ce qu'elle dit à ce que disent les inventaires, SANS IA :
 *  - serveurs confirmés, manquants dans la page, rattachés à une autre application, inconnus des inventaires
 *  - IP données par la page différentes de celles de l'inventaire
 *  - rubriques attendues présentes ou absentes (bases, flux, sauvegarde, supervision, redondance…)
 *  - ancienneté de la page
 */
const { canonicalHost, isIPv4 } = require('../resolve/entities');
const { serverEnv } = require('../lib/environment');

// rubriques attendues dans une page d'architecture (la lecture IA dit lesquelles la page couvre).
// Les clés sont des identifiants : l'interface et les rapports les traduisent (SECTION_LABELS_FR pour les rapports).
const SECTION_KEYS = ['servers', 'databases', 'flows', 'backup', 'monitoring', 'redundancy', 'contacts'];

const SECTION_LABELS_FR = {
  servers: 'serveurs',
  databases: 'bases de données',
  flows: 'flux',
  backup: 'sauvegarde',
  monitoring: 'supervision',
  redundancy: 'redondance / PRA',
  contacts: 'contacts',
  diagram: 'schéma',
};

/** Problèmes d'un contrôle en français (rapports CSV, journaux). L'interface les écrit elle-même dans sa langue. */
function verdictFr(problems) {
  if (!problems.length) return 'cohérente avec les inventaires';
  const text = {
    noReference: () => 'aucun serveur de référence (import APM / marketplace ?)',
    missing: (n) => `${n} serveur(s) manquant(s)`,
    otherApp: (n) => `${n} serveur(s) d'une autre application`,
    unknown: (n) => `${n} serveur(s) ou IP inconnu(s)`,
    ipMismatch: (n) => `${n} IP différente(s)`,
    old: (n) => `page modifiée il y a ${n} ans`,
  };
  return problems.map((p) => text[p.code](p.n)).join(' ; ');
}

const ipsOf = (node) =>
  String(node?.attrs?.ip || '')
    .split(/[,;|\s]+/)
    .filter(isIPv4);

/**
 * Contrôle d'une page d'architecture pour une application du périmètre.
 * Ce que la page cite vient de la lecture vérifiée (aucun repérage dans le texte).
 * @param {object} repo
 * @param {object} matcher  createMatcher(perimeter, repo)
 * @param {object} page     page analysée (title, tables, diagrams, updatedAt)
 * @param {string} appId
 * @param {{now?: number, cited?: object[], env?: string|null, topics?: string[]}} [opt]
 *   cited : `Verified.servers` ({ nodeId, name, inInventory }) ; env : PRD, STG, DEV ou null ;
 *   topics : rubriques que la lecture a trouvées dans la page
 */
function auditArchitecturePage(repo, matcher, page, appId, { now = Date.now(), cited: citedServers = [], env = null, topics = [] } = {}) {
  const app = matcher.apps.find((a) => a.id === appId);
  const reference = [...app.servers].map((id) => repo.getNode(id)).filter(Boolean);
  // une page "production" n'a pas à lister les serveurs de recette (si l'inventaire donne l'environnement)
  const expected = env ? reference.filter((s) => serverEnv(s) === null || serverEnv(s) === env) : reference;

  const cited = new Set(citedServers.filter((c) => c.nodeId && repo.getNode(c.nodeId)).map((c) => c.nodeId));
  const expectedIds = new Set(expected.map((s) => s.id));
  const name = (id) => repo.getNode(id)?.name || id;

  const confirmed = [...cited].filter((id) => app.servers.has(id));
  const missing = expected.filter((s) => !cited.has(s.id)).map((s) => s.name);
  const otherApp = [...cited]
    .filter((id) => !app.servers.has(id))
    .map((id) => ({ server: name(id), applications: matcher.apps.filter((a) => a.servers.has(id)).map((a) => a.name) }))
    .filter((o) => o.applications.length);

  // IP donnée par la page (lue par l'IA) différente de celle de l'inventaire
  const ipMismatch = [];
  const wrongIps = new Set();
  for (const c of citedServers) {
    if (!c.nodeId || !c.ip) continue;
    const node = repo.getNode(c.nodeId);
    const known = ipsOf(node);
    if (!node || !known.length || known.includes(c.ip)) continue;
    wrongIps.add(c.ip);
    ipMismatch.push({ server: node.name, page: [c.ip], inventory: known });
  }
  // serveurs ou IP cités que les inventaires ne connaissent pas (une IP déjà signalée comme différente n'est pas comptée deux fois)
  const unknownNames = new Set();
  for (const c of citedServers) {
    if (c.inInventory || wrongIps.has(c.name)) continue;
    unknownNames.add(isIPv4(c.name) ? c.name : canonicalHost(c.name) || c.name);
  }

  const sections = Object.fromEntries(SECTION_KEYS.map((k) => [k, (topics || []).includes(k)]));
  sections.diagram = (page.diagrams || []).length > 0;

  const updated = page.updatedAt ? new Date(page.updatedAt).getTime() : NaN;
  const ageDays = Number.isFinite(updated) ? Math.round((now - updated) / 86400000) : null;

  const completeness = expected.length ? +(confirmed.filter((id) => expectedIds.has(id)).length / expected.length).toFixed(2) : null;
  // problèmes sous forme de codes : l'interface les affiche en français ou en anglais
  const problems = [];
  if (!expected.length) problems.push({ code: 'noReference' });
  if (missing.length) problems.push({ code: 'missing', n: missing.length });
  if (otherApp.length) problems.push({ code: 'otherApp', n: otherApp.length });
  if (unknownNames.size) problems.push({ code: 'unknown', n: unknownNames.size });
  if (ipMismatch.length) problems.push({ code: 'ipMismatch', n: ipMismatch.length });
  const absent = Object.entries(sections).filter(([, ok]) => !ok).map(([k]) => k);
  if (ageDays !== null && ageDays > 730) problems.push({ code: 'old', n: Math.round(ageDays / 365) });

  return {
    environment: env,
    completeness,
    expected: expected.length,
    confirmed: confirmed.map(name),
    missing,
    otherApp,
    unknown: [...unknownNames],
    ipMismatch,
    sections,
    absentSections: absent,
    ageDays,
    problems,
    ok: problems.length === 0,
    verdict: verdictFr(problems),
  };
}

module.exports = { auditArchitecturePage, verdictFr, SECTION_KEYS, SECTION_LABELS_FR };
