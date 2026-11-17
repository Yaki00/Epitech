'use strict';
/**
 * Client minimal de l'API REST Confluence (Server / Data Center), compatible Node 16.
 *
 * Appels utilisés :
 *   GET /rest/api/space?type=global&limit=…                        liste des espaces (--list-spaces)
 *   GET /rest/api/space/{key}/content/page?expand=version&limit=…  pages d'un espace, avec leur version
 *   GET /rest/api/content/{id}?expand=body.view,body.storage,…     contenu complet d'une page
 *   GET /rest/api/content/{id}/child/attachment?limit=…            pièces jointes (images, draw.io)
 *   GET <_links.download>                                           téléchargement d'une pièce jointe
 *
 * Authentification : jeton personnel (CONFLUENCE_TOKEN, en-tête Bearer) ou identifiant + mot de passe (Basic).
 * Nouvelles tentatives sur 429 / 5xx / erreur réseau, avec Retry-After si Confluence le donne.
 */
const { httpFetch } = require('../lib/httpFetch');
const { sleep, backoffDelay } = require('../lib/limiter');

class ConfluenceError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'ConfluenceError';
    this.status = status;
    this.url = url;
  }
}

/**
 * @param {object} cfg { baseUrl, token?, user?, password?, timeoutMs?, maxRetries? }
 *   baseUrl inclut le chemin de contexte s'il y en a un : https://confluence.exemple.local ou https://exemple.local/wiki
 * @param {object} [deps] { fetch, logger, backoffBaseMs } (injectés dans les tests)
 */
function createConfluenceApi(cfg, deps = {}) {
  const doFetch = deps.fetch || httpFetch;
  const log = deps.logger || null;
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new ConfluenceError('CONFLUENCE_BASE_URL vide dans backend/.env');
  const auth = cfg.token
    ? `Bearer ${cfg.token}`
    : cfg.user
      ? `Basic ${Buffer.from(`${cfg.user}:${cfg.password || ''}`).toString('base64')}`
      : null;
  const maxRetries = cfg.maxRetries ?? 4;
  const stats = { requests: 0, retries: 0, bytes: 0 };

  /** URL absolue : chemin d'API (/rest/…) ou lien renvoyé par Confluence (/download/…, déjà avec le contexte ou non). */
  function absolute(p) {
    if (/^https?:\/\//i.test(p)) return p;
    const contextPath = new URL(base).pathname.replace(/\/+$/, '');
    // les liens _links.download de Confluence commencent parfois déjà par le chemin de contexte (/wiki/download/…)
    if (contextPath && p.startsWith(`${contextPath}/`)) return `${new URL(base).origin}${p}`;
    return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
  }

  async function request(pathOrUrl, { binary = false, redirects = 3 } = {}) {
    let url = absolute(pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      stats.requests++;
      let res;
      try {
        res = await doFetch(url, { headers: { Accept: binary ? '*/*' : 'application/json', ...(auth ? { Authorization: auth } : {}) }, timeoutMs: cfg.timeoutMs || 60000 });
      } catch (err) {
        if (attempt >= maxRetries) throw new ConfluenceError(`Erreur réseau sur ${url} : ${err.message}`, { url });
        stats.retries++;
        await sleep(backoffDelay(attempt, deps.backoffBaseMs ?? 1000));
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location && redirects > 0) {
        url = new URL(res.headers.location, url).toString();
        redirects--;
        attempt--;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxRetries) throw new ConfluenceError(`HTTP ${res.status} sur ${url}`, { status: res.status, url });
        stats.retries++;
        const retryAfter = Number(res.headers?.['retry-after']);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt, deps.backoffBaseMs ?? 1000);
        log?.warn(`HTTP ${res.status}, nouvelle tentative dans ${Math.round(wait / 1000)} s`, { url });
        await sleep(wait);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ConfluenceError(`HTTP ${res.status} : accès refusé (vérifiez CONFLUENCE_TOKEN ou CONFLUENCE_USER / CONFLUENCE_PASSWORD)`, { status: res.status, url });
      }
      if (!res.ok) throw new ConfluenceError(`HTTP ${res.status} sur ${url}`, { status: res.status, url });
      if (binary) {
        const buf = await res.buffer();
        stats.bytes += buf.length;
        return buf;
      }
      const text = await res.text();
      stats.bytes += text.length;
      try {
        return JSON.parse(text);
      } catch (err) {
        // souvent une page de connexion HTML renvoyée à la place du JSON
        throw new ConfluenceError(`Réponse non JSON sur ${url} (page de connexion ? mauvais CONFLUENCE_BASE_URL ?) : ${text.slice(0, 120)}`, { url });
      }
    }
  }

  /** Parcourt une liste paginée (results / start / limit / _links.next). */
  async function paginate(pathWithQuery, limit) {
    const out = [];
    let start = 0;
    for (;;) {
      const sep = pathWithQuery.includes('?') ? '&' : '?';
      const page = await request(`${pathWithQuery}${sep}limit=${limit}&start=${start}`);
      const results = page.results || [];
      out.push(...results);
      if (!results.length || !page._links?.next) break;
      start += results.length;
    }
    return out;
  }

  const enc = encodeURIComponent;
  return {
    stats,
    absolute,
    /** Vérifie l'accès (doctor) : un seul petit appel authentifié. */
    ping: () => request('/rest/api/space?limit=1'),
    listSpaces: () => paginate('/rest/api/space?type=global', 200),
    /** Pages d'un espace : [{id, title, version: {number, when}}] */
    listPages: (spaceKey) => paginate(`/rest/api/space/${enc(spaceKey)}/content/page?expand=version`, 200),
    getPage: (id) => request(`/rest/api/content/${enc(id)}?expand=body.view,body.storage,version,ancestors,metadata.labels,space`),
    listAttachments: (id) => paginate(`/rest/api/content/${enc(id)}/child/attachment?expand=version`, 200),
    download: (link) => request(link, { binary: true }),
  };
}

module.exports = { createConfluenceApi, ConfluenceError };
