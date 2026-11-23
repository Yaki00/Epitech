'use strict';
/**
 * États Naemon : calcul pur (aucune lecture réseau ni disque, aucune horloge).
 *
 * À partir du graphe et d'un relevé normalisé (hôtes + services), calcule l'état de chaque serveur,
 * de chaque application (par environnement) et les applications menacées par une dépendance en panne.
 * Le relevé n'est jamais modifié.
 */
const { traverse } = require('../graph/impact');
const { serverEnv, ENVS } = require('../lib/environment');

const SERVICE_STATE = { 1: 'warning', 2: 'critical', 3: 'unknown' };
// plus grand = plus grave ; sert à choisir le pire service et à départager deux hôtes pour un même serveur
const SEVERITY = { ok: 0, unknown: 1, warning: 2, critical: 3, down: 4 };

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Serveurs actifs du graphe reconnus pour un nom, un FQDN ou une IP. */
function serversFor(repo, text) {
  return repo.resolve(text).filter((n) => n.type === 'server' && !isRetired(n));
}

/** État d'un serveur à partir de son hôte Naemon et des services de cet hôte. */
function serverState(h, services) {
  const base = { ack: Boolean(h.ack), output: h.output || '', lastCheck: h.lastCheck == null ? null : h.lastCheck };
  const list = services.map((s) => ({ description: s.description, state: s.state, output: s.output || '', lastCheck: s.lastCheck == null ? null : s.lastCheck, ack: Boolean(s.ack), downtime: Boolean(s.downtime) }));
  if (h.downtime) return { ...base, state: 'maintenance', services: list };
  if (h.state === 1) return { ...base, state: 'down', services: list };
  if (h.state === 2) return { ...base, state: 'unknown', services: list };
  // une maintenance sur un seul service ne compte pas dans le pire état
  let worst = null;
  for (const s of list) {
    const st = SERVICE_STATE[s.state];
    if (!st || s.downtime) continue;
    if (!worst || SEVERITY[st] > SEVERITY[worst.state]) worst = { state: st, s };
  }
  if (!worst) return { ...base, state: 'ok', services: list };
  return { state: worst.state, ack: worst.s.ack, output: worst.s.output, lastCheck: worst.s.lastCheck, services: list };
}

/** État d'une application dans un environnement, depuis les états de ses serveurs. */
function envState(states) {
  const counted = states.filter((s) => s !== 'maintenance' && s !== 'not_monitored' && s !== 'unknown');
  if (!counted.length) return 'unknown';
  if (counted.every((s) => s === 'down' || s === 'critical')) return 'down';
  if (counted.some((s) => s === 'warning' || s === 'critical' || s === 'down')) return 'degraded';
  return 'ok';
}

/** Serveurs actifs d'une application (mêmes liens runs_on que la fiche application). */
function appServers(repo, app) {
  const ids = new Set(repo.edgesFrom(app.id).filter((e) => e.type === 'runs_on' && !isRetired(e)).map((e) => e.dst));
  return [...ids].map((id) => repo.getNode(id)).filter((n) => n && n.type === 'server' && !isRetired(n));
}

/**
 * @param {object} repo
 * @param {{fetchedAt, hosts: object[], services: object[]}} raw
 * @param {{matcher?: object|null}} [opt]
 */
function computeStatus(repo, raw, { matcher = null } = {}) {
  const hosts = (raw && raw.hosts) || [];
  const services = (raw && raw.services) || [];
  const servicesByHost = new Map();
  for (const s of services) {
    const k = lc(s.host);
    if (!servicesByHost.has(k)) servicesByHost.set(k, []);
    servicesByHost.get(k).push(s);
  }

  // noms de hostgroups déclarés par application (champ facultatif naemonHostgroups)
  const declaredGroups = new Set();
  if (matcher) for (const a of matcher.apps || []) for (const g of a.naemonHostgroups || []) declaredGroups.add(lc(g));
  const groupInPerimeter = (g) => {
    if (!matcher || !lc(g)) return false;
    if (declaredGroups.has(lc(g))) return true;
    return Boolean(matcher.matchName(g, { minScore: 0.95 }));
  };

  const result = { fetchedAt: (raw && raw.fetchedAt) || null, servers: {}, apps: {}, atRisk: {}, unmatchedHosts: [] };

  // 1. hôtes -> serveurs du graphe
  for (const h of hosts) {
    let matched = serversFor(repo, h.name);
    if (!matched.length && h.address) matched = serversFor(repo, h.address);
    if (!matched.length) {
      if ((h.groups || []).some(groupInPerimeter)) result.unmatchedHosts.push(h.name);
      continue;
    }
    const st = serverState(h, servicesByHost.get(lc(h.name)) || []);
    for (const n of matched) {
      const prev = result.servers[n.id];
      // deux hôtes pour un même serveur : on garde le plus grave (la maintenance ne l'emporte pas sur une panne)
      if (!prev || (SEVERITY[st.state] || 0) > (SEVERITY[prev.state] || 0)) result.servers[n.id] = st;
    }
  }
  for (const n of repo.listByType('server')) {
    if (isRetired(n) || result.servers[n.id]) continue;
    result.servers[n.id] = { state: 'not_monitored', ack: false, output: '', lastCheck: null, services: [] };
  }

  // 2. applications
  const apps = repo.listByType('application').filter((a) => !isRetired(a));
  for (const app of apps) {
    const perEnv = {};
    for (const srv of appServers(repo, app)) {
      const env = serverEnv(srv);
      if (!env) continue;
      (perEnv[env] ||= []).push((result.servers[srv.id] || { state: 'not_monitored' }).state);
    }
    const byEnv = {};
    for (const env of ENVS) if (perEnv[env]) byEnv[env] = envState(perEnv[env]);
    result.apps[app.id] = { state: byEnv.PRD || byEnv.STG || 'unknown', byEnv };
  }

  // 3. impact réel : applications qui dépendent d'une application en panne ou dégradée
  const failing = Object.keys(result.apps)
    .filter((id) => result.apps[id].state === 'down' || result.apps[id].state === 'degraded')
    .sort();
  for (const failId of failing) {
    const t = traverse(repo, failId, { direction: 'upstream', edgeTypes: ['calls', 'uses_db'] });
    if (!t) continue;
    const from = new Map(t.items.map((i) => [i.id, i]));
    for (const item of t.items) {
      if (item.type !== 'application' || !result.apps[item.id]) continue;
      if (failing.includes(item.id)) continue; // déjà touchée : son propre état est plus parlant
      const prev = result.atRisk[item.id];
      if (prev && prev.path.length <= item.depth + 1) continue;
      const path = [item.id];
      for (let cur = from.get(item.id); cur && cur.via; cur = from.get(cur.via.from)) path.push(cur.via.from);
      result.atRisk[item.id] = { because: failId, path };
    }
  }
  return result;
}

module.exports = { computeStatus };
