'use strict';
/**
 * Pages d'architecture : les reconnaître, puis les contrôler par rapport aux inventaires (APM, marketplace).
 *
 * Une page d'architecture (DAT, "Architecture", "Serveurs de production", "Infra"…) devrait lister les serveurs
 * de l'application. On compare ce qu'elle dit à ce que disent les inventaires, SANS IA :
 *  - serveurs confirmés, manquants dans la page, rattachés à une autre application, inconnus des inventaires
 *  - IP écrites dans un tableau différentes de celles de l'inventaire
 *  - rubriques attendues présentes ou absentes (bases, flux, sauvegarde, supervision, redondance…)
 *  - ancienneté de la page
 */
const { normalize } = require('./perimeter');
const { canonicalHost, isIPv4 } = require('../resolve/entities');

// mots du titre ou des pages parentes qui signalent une page d'architecture (modifiables dans perimeter.json)
const DEFAULT_KEYWORDS = [
  'architecture', 'archi', 'dat', 'serveur', 'serveurs', 'server', 'servers', 'infrastructure', 'infra',
  'production', 'topologie', 'topology', 'hebergement', 'hosting', 'deploiement', 'deployment',
  'environnement', 'environnements', 'socle', 'machines', 'vm',
];

// rubriques attendues dans une page d'architecture : présentes si un de ces mots apparaît (titres ou texte)
const SECTIONS = {
  serveurs: ['serveur', 'serveurs', 'server', 'servers', 'hostname', 'vm', 'machine'],
  'bases de données': ['base', 'bases', 'bdd', 'sgbd', 'base de donnees', 'database', 'oracle', 'sql server', 'postgres', 'mysql', 'mongodb', 'db'],
  flux: ['flux', 'flow', 'interface', 'interfaces', 'echange', 'echanges', 'api', 'mq', 'sftp', 'port'],
  sauvegarde: ['sauvegarde', 'sauvegardes', 'backup', 'backups', 'restauration', 'restore'],
  supervision: ['supervision', 'monitoring', 'naemon', 'nagios', 'alerte', 'alertes'],
  'redondance / PRA': ['redondance', 'cluster', 'actif passif', 'active passive', 'failover', 'bascule', 'pra', 'pca', 'drp', 'haute disponibilite', 'load balancer', 'f5', 'vip'],
  contacts: ['contact', 'contacts', 'equipe', 'support', 'responsable', 'owner', 'astreinte'],
};

// en-têtes de colonnes (mots entiers) : pas "nom" ni "adresse", trop fréquents dans les tableaux de contacts
const HOST_HEADERS = ['serveur', 'serveurs', 'server', 'servers', 'hostname', 'host', 'hote', 'machine', 'vm', 'fqdn'];
const IP_HEADERS = ['ip'];

const hasWord = (norm, word) => ` ${norm} `.includes(` ${word} `);
const headerIs = (h, list) => list.some((w) => hasWord(normalize(h), w));

/**
 * La page est-elle une page d'architecture ?
 * @returns {{score: number, reasons: string[]}} score >= 0.6 : oui
 */
function architectureScore(page, { keywords = DEFAULT_KEYWORDS, ancestors = [] } = {}) {
  const reasons = [];
  let score = 0;
  const title = normalize(page.title);
  const kwTitle = keywords.find((k) => hasWord(title, normalize(k)));
  if (kwTitle) {
    score = Math.max(score, 0.8);
    reasons.push(`titre « ${kwTitle} »`);
  }
  const kwParent = ancestors.map((a) => normalize(typeof a === 'string' ? a : a.title)).map((a) => keywords.find((k) => hasWord(a, normalize(k)))).find(Boolean);
  if (kwParent) {
    score = Math.max(score, 0.5);
    reasons.push(`page parente « ${kwParent} »`);
  }
  if ((page.tables || []).some((t) => (t.headers || []).some((h) => headerIs(h, HOST_HEADERS)) && (t.headers || []).some((h) => headerIs(h, IP_HEADERS)))) {
    score = Math.max(score, 0.7);
    reasons.push('tableau serveurs / IP');
  }
  if ((page.diagrams || []).length) {
    score = Math.max(score, 0.5);
    reasons.push('schéma');
  }
  const mentions = (page.entities?.hosts || []).length + (page.entities?.ips || []).length;
  if (mentions >= 3) {
    score = Math.max(score, 0.5);
    reasons.push(`${mentions} serveurs ou IP cités`);
  }
  // plusieurs signaux se renforcent
  if (reasons.length >= 2) score = Math.min(0.95, score + 0.1 * (reasons.length - 1));
  return { score: +score.toFixed(2), reasons };
}

/** Environnement visé par la page d'après son titre ("Serveurs de production" -> prod). */
function pageEnvironment(title) {
  const t = normalize(title);
  if (/\b(preprod|pre prod|preproduction|pre production|recette|uat|qualif|homologation)\b/.test(t)) return 'hors-prod';
  if (/\b(dev|developpement|test|tests)\b/.test(t)) return 'hors-prod';
  if (/\b(prod|production|prd)\b/.test(t)) return 'prod';
  return null;
}
const serverEnv = (s) => {
  const e = normalize(s?.attrs?.environment || '');
  if (!e) return null;
  return /\b(prod|production|prd|p)\b/.test(e) && !/pre/.test(e) ? 'prod' : 'hors-prod';
};

const ipsOf = (node) =>
  String(node?.attrs?.ip || '')
    .split(/[,;|\s]+/)
    .filter(isIPv4);

/**
 * Contrôle d'une page d'architecture pour une application du périmètre.
 * @param {object} repo
 * @param {object} matcher  createMatcher(perimeter, repo)
 * @param {object} page     page analysée (title, sections, tables, entities, diagrams, updatedAt)
 * @param {string} appId
 * @param {{now?: number}} [opt]
 */
function auditArchitecturePage(repo, matcher, page, appId, { now = Date.now() } = {}) {
  const app = matcher.apps.find((a) => a.id === appId);
  const env = pageEnvironment(page.title);
  const reference = [...app.servers].map((id) => repo.getNode(id)).filter(Boolean);
  // une page "production" n'a pas à lister les serveurs de recette (si l'inventaire donne l'environnement)
  const expected = env ? reference.filter((s) => serverEnv(s) === null || serverEnv(s) === env) : reference;

  const text = [page.title, ...(page.sections || []).map((s) => `${s.heading || ''}\n${s.text || ''}`)].join('\n');
  // valeurs des colonnes "serveur" des tableaux : candidats même s'ils ne suivent aucun motif de nom
  const tableHosts = [];
  const ipChecks = [];
  for (const t of page.tables || []) {
    const hostCol = (t.headers || []).find((h) => headerIs(h, HOST_HEADERS));
    const ipCol = (t.headers || []).find((h) => headerIs(h, IP_HEADERS));
    if (!hostCol) continue;
    for (const row of t.rows || []) {
      const host = String(row[hostCol] || '').trim().split(/[\s,;/]+/)[0];
      if (!host) continue;
      tableHosts.push(host);
      if (ipCol) ipChecks.push({ host, ips: String(row[ipCol] || '').split(/[\s,;/]+/).filter(isIPv4) });
    }
  }

  const cited = matcher.serversIn(text, [...(page.entities?.hosts || []), ...(page.entities?.ips || []), ...tableHosts]);
  const expectedIds = new Set(expected.map((s) => s.id));
  const name = (id) => repo.getNode(id)?.name || id;

  const confirmed = [...cited].filter((id) => app.servers.has(id));
  const missing = expected.filter((s) => !cited.has(s.id)).map((s) => s.name);
  const otherApp = [...cited].filter((id) => !app.servers.has(id)).map((id) => {
    const owners = matcher.apps.filter((a) => a.servers.has(id)).map((a) => a.name);
    return `${name(id)} (${owners.join(', ')})`;
  });

  // hôtes du texte ou des tableaux qui ne correspondent à aucun serveur connu
  const unknown = new Set();
  for (const h of [...(page.entities?.hosts || []), ...tableHosts]) {
    if (isIPv4(h)) continue;
    if (!repo.resolve(h).some((n) => n.type === 'server')) unknown.add(canonicalHost(h) || h);
  }
  const unknownIps = (page.entities?.ips || []).filter((ip) => !repo.resolve(ip).some((n) => n.type === 'server'));

  const ipMismatch = [];
  for (const c of ipChecks) {
    const [server] = repo.resolve(c.host).filter((n) => n.type === 'server');
    const known = ipsOf(server && repo.getNode(server.id));
    if (!server || !known.length || !c.ips.length) continue;
    const wrong = c.ips.filter((ip) => !known.includes(ip));
    if (wrong.length) ipMismatch.push(`${server.name} : page ${wrong.join(', ')} / inventaire ${known.join(', ')}`);
  }

  const all = normalize(text);
  const sections = Object.fromEntries(Object.entries(SECTIONS).map(([k, words]) => [k, words.some((w) => hasWord(all, w))]));
  if ((page.diagrams || []).length) sections['schéma'] = true;
  else sections['schéma'] = false;

  const updated = page.updatedAt ? new Date(page.updatedAt).getTime() : NaN;
  const ageDays = Number.isFinite(updated) ? Math.round((now - updated) / 86400000) : null;

  const completeness = expected.length ? +(confirmed.filter((id) => expectedIds.has(id)).length / expected.length).toFixed(2) : null;
  const problems = [];
  if (!expected.length) problems.push("aucun serveur de référence (import APM / marketplace ?)");
  if (missing.length) problems.push(`${missing.length} serveur(s) manquant(s)`);
  if (otherApp.length) problems.push(`${otherApp.length} serveur(s) d'une autre application`);
  if (unknown.size || unknownIps.length) problems.push(`${unknown.size + unknownIps.length} serveur(s) ou IP inconnu(s)`);
  if (ipMismatch.length) problems.push(`${ipMismatch.length} IP différente(s)`);
  const absent = Object.entries(sections).filter(([, ok]) => !ok).map(([k]) => k);
  if (ageDays !== null && ageDays > 730) problems.push(`page modifiée il y a ${Math.round(ageDays / 365)} ans`);

  return {
    environment: env,
    completeness,
    expected: expected.length,
    confirmed: confirmed.map(name),
    missing,
    otherApp,
    unknown: [...unknown, ...unknownIps],
    ipMismatch,
    sections,
    absentSections: absent,
    ageDays,
    verdict: problems.length ? problems.join(' ; ') : 'cohérente avec les inventaires',
  };
}

module.exports = { architectureScore, auditArchitecturePage, pageEnvironment, DEFAULT_KEYWORDS, SECTIONS };
