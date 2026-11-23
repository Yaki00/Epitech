'use strict';
/**
 * Réconciliation des entités : le même serveur peut apparaître sous la forme
 * "SRV01", "srv01.domaine.local" ou "10.1.2.3". On calcule une clé canonique
 * et des alias. Les règles déterministes passent AVANT l'IA :
 * l'IA ne sert qu'aux cas ambigus.
 */

// IP candidate : 4 groupes de chiffres, pas collée à un chiffre/point avant, ni suivie de ".chiffre" ou d'un chiffre.
// Exclut les numéros de téléphone (01.23.45.82.17) et les numéros de version (v1.10.0.1.2).
const IP_CANDIDATE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g;
/** Octet valide : 0 à 255, sans zéro en tête (« 01 » est un morceau de téléphone, pas une IP). */
const isValidOctet = (o) => (o === '0' || /^[1-9]\d{0,2}$/.test(o)) && Number(o) <= 255;
const FQDN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const WIN_PATH = /(?:^|[\s"'(])([a-z]:\\[^\s"'<>|]*|\\\\[^\s"'<>|]+)/gi;
const UNIX_PATH = /(?:^|[\s"'(])(\/(?:[\w.-]+\/)*[\w.-]+\/?)/g;

function isIPv4(s) {
  const parts = String(s).trim().split('.');
  return parts.length === 4 && parts.every(isValidOctet);
}

/** IP d'un texte libre, sans doublon, dans l'ordre d'apparition. */
function extractIps(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(IP_CANDIDATE)) {
    const octets = m.slice(1, 5);
    if (octets.every(isValidOctet)) out.add(octets.join('.'));
  }
  return [...out];
}

/** Motif des noms courts de serveurs internes, configurable (ex: "^[a-z]{2,4}\\d{2,}[a-z0-9]*$"). */
function hostPattern() {
  const p = process.env.HOST_SHORTNAME_PATTERN;
  return p ? new RegExp(p, 'i') : null;
}

/** Clé canonique d'un serveur : nom court en minuscules (ou IP telle quelle). */
function canonicalHost(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  if (isIPv4(s)) return s;
  return s.split('.')[0];
}

/** Toutes les formes sous lesquelles on peut retrouver ce serveur. */
function hostAliases(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!s) return [];
  const out = new Set([s]);
  if (!isIPv4(s)) out.add(s.split('.')[0]);
  return [...out];
}

/**
 * Classe un token sans IA.
 * @returns {'ip'|'url'|'filesystem'|'host'|'unknown'}
 */
function classifyToken(token) {
  const t = String(token || '').trim();
  if (!t) return 'unknown';
  if (isIPv4(t)) return 'ip';
  if (/^https?:\/\//i.test(t)) return 'url';
  if (/^[a-z]:\\/i.test(t) || t.startsWith('\\\\') || t.startsWith('/') || t.startsWith('~/')) return 'filesystem';
  if (/^(?:[a-z0-9-]+\.){2,}[a-z]{2,}$/i.test(t)) return 'host';
  const hp = hostPattern();
  if (hp && hp.test(t)) return 'host';
  return 'unknown';
}

/** Extraction déterministe d'IP, FQDN, URL et chemins dans un texte libre. */
function extractEntities(text) {
  const src = String(text || '');
  const urls = [...new Set(src.match(URL_RE) || [])];
  const withoutUrls = src.replace(URL_RE, ' ');
  const ips = extractIps(withoutUrls);
  const fqdns = [...new Set((withoutUrls.match(FQDN) || []).map((s) => s.toLowerCase()))].filter(
    (s) => !isIPv4(s) && !/\.(png|jpe?g|gif|svg|pdf|docx?|xlsx?|pptx?|txt|log|json|xml|ya?ml|zip|jar|war|sh|js|java|py)$/i.test(s)
  );
  const paths = [];
  for (const re of [WIN_PATH, UNIX_PATH]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(withoutUrls))) if (m[1].length > 2) paths.push(m[1]);
  }
  const hosts = new Set(fqdns);
  const hp = hostPattern();
  if (hp) {
    for (const tok of withoutUrls.split(/[^\w.-]+/)) if (tok && hp.test(tok)) hosts.add(tok.toLowerCase());
  }
  return { ips, hosts: [...hosts], urls, paths: [...new Set(paths)] };
}

module.exports = { canonicalHost, hostAliases, classifyToken, extractEntities, extractIps, isIPv4 };
