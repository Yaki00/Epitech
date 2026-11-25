'use strict';
/**
 * Téléchargement d'un export (ex. la marketplace) depuis un lien direct, au plus une fois par jour.
 *
 * - Vérifié aujourd'hui déjà : rien n'est fait (sauf force).
 * - Contenu identique au fichier en place : fichier inchangé, seule la date de vérification est notée.
 * - Contenu différent : l'ancien fichier est remplacé (écriture dans un fichier temporaire puis renommage).
 * - Réponse qui n'est pas un CSV (page de connexion HTML, fichier vide, classeur .xlsx) : erreur, l'ancien fichier est gardé.
 *
 * L'état est gardé à côté du fichier : <fichier>.telechargement.json (date, empreinte, taille ; jamais l'URL ni les secrets).
 */
const fs = require('fs');
const path = require('path');
const { httpFetch } = require('../lib/httpFetch');
const { sha256 } = require('../lib/hash');

/** Date locale AAAA-MM-JJ (le "jour" de la vérification est celui du poste, pas l'UTC). */
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Lit les réglages <PREFIX>_URL, _TOKEN, _USER, _PASSWORD, _COOKIE dans l'environnement. */
function downloadSettings(prefix, env = process.env) {
  const get = (k) => (env[`${prefix}_${k}`] || '').trim();
  return { url: get('URL'), token: get('TOKEN'), user: get('USER'), password: env[`${prefix}_PASSWORD`] || '', cookie: get('COOKIE') };
}

function authHeaders({ token, user, password, cookie }) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  else if (user) h.Authorization = `Basic ${Buffer.from(`${user}:${password || ''}`).toString('base64')}`;
  if (cookie) h.Cookie = cookie;
  return h;
}

/** Le contenu ressemble-t-il à un export CSV ? Renvoie un message d'erreur, ou null si oui. */
function checkCsv(buf, contentType = '') {
  if (!buf.length) return 'fichier vide';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'classeur Excel (.xlsx) reçu au lieu d\'un CSV : choisir l\'export CSV dans le lien';
  const head = buf.slice(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (/text\/html/i.test(contentType) || head.startsWith('<!doctype') || head.startsWith('<html')) {
    return 'page HTML reçue au lieu du fichier (page de connexion ? lien expiré ?)';
  }
  const firstLine = head.split(/\r?\n/)[0];
  if (!/[;,\t|]/.test(firstLine)) return `première ligne sans séparateur (« ${firstLine.slice(0, 60)} ») : ce n'est pas un CSV`;
  return null;
}

/**
 * @param {object} p
 * @param {string} p.url
 * @param {string} p.target        chemin du fichier à tenir à jour
 * @param {object} [p.auth]        { token, user, password, cookie }
 * @param {boolean} [p.force]      télécharger même si déjà vérifié aujourd'hui
 * @param {Date} [p.now]
 * @param {Function} [p.fetch]     injecté dans les tests
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{status: 'déjà vérifié aujourd\'hui'|'identique'|'remplacé'|'nouveau', size?: number, file: string}>}
 */
async function downloadIfNeeded({ url, target, auth = {}, force = false, now = new Date(), fetch = httpFetch, timeoutMs = 300000 }) {
  const stateFile = `${target}.telechargement.json`;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    state = {};
  }
  const today = localDay(now);
  if (!force && state.checkedDay === today && fs.existsSync(target)) return { status: "déjà vérifié aujourd'hui", file: target };

  // lien direct : on suit les redirections (portail, stockage), 5 au plus
  let current = url;
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(current, { headers: { Accept: 'text/csv,*/*', ...authHeaders(auth) }, timeoutMs });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location && hop < 5) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    break;
  }
  if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status} : accès refusé (jeton, identifiant ou cookie à renseigner dans .env)`);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur le lien de téléchargement`);
  const buf = await res.buffer();
  const problem = checkCsv(buf, res.headers?.['content-type']);
  if (problem) throw new Error(`${problem} ; l'ancien fichier est gardé`);

  const hash = sha256(buf);
  const existed = fs.existsSync(target);
  const same = existed && sha256(fs.readFileSync(target)) === hash;
  if (!same) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target); // remplace l'ancien d'un coup : jamais de fichier à moitié écrit
  }
  const nowIso = now.toISOString();
  const next = { checkedDay: today, checkedAt: nowIso, sha256: hash, size: buf.length, changedAt: same ? state.changedAt || null : nowIso };
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
  return { status: same ? 'identique' : existed ? 'remplacé' : 'nouveau', size: buf.length, file: target };
}

module.exports = { downloadIfNeeded, downloadSettings, checkCsv, localDay };
