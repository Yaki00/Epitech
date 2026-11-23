'use strict';
/**
 * Relève de l'état Naemon par l'API REST de Thruk (lecture seule : deux GET).
 * Le certificat d'entreprise passe par NODE_EXTRA_CA_CERTS, comme le reste du projet.
 */
const { httpFetch } = require('../lib/httpFetch');

const HOST_COLUMNS = 'name,address,state,plugin_output,last_check,groups,acknowledged,scheduled_downtime_depth';
const SERVICE_COLUMNS = 'host_name,description,state,plugin_output,last_check,acknowledged,scheduled_downtime_depth';

function authHeaders(cfg) {
  const h = { Accept: 'application/json' };
  if (cfg.token) h['X-Thruk-Auth-Key'] = cfg.token;
  else if (cfg.user) h.Authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.password || ''}`).toString('base64')}`;
  return h;
}

async function getList(http, url, cfg) {
  const res = await http(url, { headers: authHeaders(cfg), timeoutMs: cfg.timeoutMs || 30000 });
  const text = await res.text();
  if (!res.ok) throw new Error(`Thruk HTTP ${res.status} sur ${url.split('?')[0]}${res.status === 401 || res.status === 403 ? ' (jeton ou identifiants refusés)' : ''}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    if (/^\s*</.test(text)) throw new Error('Thruk : page HTML reçue (connexion ?), vérifiez NAEMON_TOKEN ou NAEMON_USER et NAEMON_PASSWORD');
    throw new Error(`Thruk : réponse illisible (${err.message})`);
  }
  if (!Array.isArray(data)) throw new Error('Thruk : réponse inattendue (une liste était attendue)');
  return data;
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * @param {{thrukUrl, token?, user?, password?, timeoutMs?}} cfg
 * @returns {Promise<{fetchedAt: string, hosts: object[], services: object[]}>} relevé normalisé (lastCheck en secondes epoch)
 */
async function fetchThruk(cfg, { http = httpFetch, now = Date.now } = {}) {
  const base = String(cfg.thrukUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('NAEMON_THRUK_URL est vide');
  const hosts = await getList(http, `${base}/r/hosts?columns=${HOST_COLUMNS}`, cfg);
  const services = await getList(http, `${base}/r/services?columns=${SERVICE_COLUMNS}`, cfg);
  return {
    fetchedAt: new Date(now()).toISOString(),
    hosts: hosts.map((h) => ({
      name: String(h.name || ''),
      address: String(h.address || ''),
      state: num(h.state) === null ? 2 : num(h.state),
      output: String(h.plugin_output || ''),
      lastCheck: num(h.last_check),
      groups: Array.isArray(h.groups) ? h.groups.map(String) : [],
      ack: Number(h.acknowledged) > 0,
      downtime: Number(h.scheduled_downtime_depth) > 0,
    })),
    services: services.map((s) => ({
      host: String(s.host_name || ''),
      description: String(s.description || ''),
      state: num(s.state) === null ? 3 : num(s.state),
      output: String(s.plugin_output || ''),
      lastCheck: num(s.last_check),
      ack: Number(s.acknowledged) > 0,
      downtime: Number(s.scheduled_downtime_depth) > 0,
    })),
  };
}

module.exports = { fetchThruk };
