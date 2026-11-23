'use strict';
/**
 * Vues "prêtes à afficher" pour le frontend, sans dépendance à Express
 * (testées directement par jest).
 */

const { serverEnv, appCriticality, ENVS } = require('../lib/environment');
const { docScore } = require('../quality/docScore');

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);

/**
 * Contexte facultatif des vues : { status } = dernier état Naemon calculé (computeStatus), ou absent.
 * Sans état : serveurs et applications sont « unknown » (jamais « not_monitored », qui est un constat).
 */
function serverState(ctx, id) {
  const status = ctx && ctx.status;
  if (!status) return 'unknown';
  return (status.servers && status.servers[id] && status.servers[id].state) || 'not_monitored';
}

function appStatus(ctx, id) {
  const status = ctx && ctx.status;
  const st = status && status.apps && status.apps[id];
  const risk = status && status.atRisk && status.atRisk[id];
  return { state: st ? st.state : 'unknown', byEnv: st ? { ...st.byEnv } : {}, atRisk: risk ? { because: risk.because, path: [...risk.path] } : null };
}

/** Résumé d'une application : compteurs et infos de la fiche. */
function applicationSummary(repo, app, ctx = null) {
  const out = repo.edgesFrom(app.id).filter((e) => !isRetired(e));
  const serverIds = new Set(out.filter((e) => e.type === 'runs_on').map((e) => e.dst));
  const dbIds = new Set(out.filter((e) => e.type === 'uses_db').map((e) => e.dst));
  const envs = new Set();
  for (const id of serverIds) {
    const srv = repo.getNode(id);
    if (!srv || isRetired(srv)) {
      serverIds.delete(id);
      continue;
    }
    const env = serverEnv(srv);
    if (env) envs.add(env);
  }
  return {
    id: app.id,
    name: app.name,
    inPerimeter: Boolean(app.attrs.perimeter),
    criticality: appCriticality(app),
    owner: app.attrs.owner || null,
    supportTeam: app.attrs.supportTeam || null,
    description: app.attrs.description || null,
    summary: app.attrs.summary || null,
    environments: ENVS.filter((e) => envs.has(e)).sort(),
    servers: serverIds.size,
    databases: dbIds.size,
    lastSync: app.updatedAt || null,
    retired: isRetired(app),
    status: appStatus(ctx, app.id),
    docScore: docScore(repo, app.id),
  };
}

function listApplications(repo, ctx = null) {
  return repo.listByType('application').map((a) => applicationSummary(repo, a, ctx));
}

/** Liens sortants d'un type donné, avec le nœud cible détaillé (onglets Serveurs / Bases). */
function linkedNodes(repo, id, edgeType, ctx = null) {
  const best = new Map();
  for (const e of repo.edgesFrom(id).filter((x) => x.type === edgeType)) {
    const prev = best.get(e.dst);
    const live = Boolean(prev && prev.live) || !isRetired(e); // actif tant qu'un lien non retiré existe
    if (prev && prev.confidence >= e.confidence) {
      prev.sources.add(e.source);
      prev.live = live;
      continue;
    }
    best.set(e.dst, { confidence: e.confidence, live, sources: new Set([...(prev?.sources || []), e.source]) });
  }
  return [...best.entries()]
    .map(([dst, info]) => {
      const n = repo.getNode(dst);
      return n && { id: n.id, name: n.name, type: n.type, attrs: n.attrs, retired: isRetired(n) || !info.live, ...(n.type === 'server' ? { env: serverEnv(n), state: serverState(ctx, n.id) } : {}), confidence: info.confidence, sources: [...info.sources] };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Fiche complète d'une application. */
function applicationDetail(repo, id, ctx = null) {
  const app = repo.getNode(id);
  if (!app || app.type !== 'application') return null;
  // une page peut être rattachée par plusieurs sources (règles, tri IA) : une seule entrée, avec son contrôle d'architecture
  const byDoc = new Map();
  for (const e of repo.edgesFrom(id).filter((x) => x.type === 'documented_in')) {
    const d = repo.getNode(e.dst);
    if (!d) continue;
    const prev = byDoc.get(d.id);
    byDoc.set(d.id, {
      id: d.id,
      name: d.name,
      url: d.attrs.url || null,
      architecture: d.attrs.pageKind === 'architecture',
      audit: prev?.audit || e.attrs.audit || null,
    });
  }
  // pages d'architecture d'abord
  const docs = [...byDoc.values()].sort((a, b) => Number(b.architecture) - Number(a.architecture) || a.name.localeCompare(b.name));
  return {
    ...applicationSummary(repo, app, ctx),
    attrs: app.attrs,
    serverList: linkedNodes(repo, id, 'runs_on', ctx),
    databaseList: linkedNodes(repo, id, 'uses_db'),
    callsList: linkedNodes(repo, id, 'calls'),
    usedBy: [...new Set(repo.edgesTo(id).filter((e) => e.type === 'calls').map((e) => e.src))]
      .map((src) => repo.getNode(src))
      .filter(Boolean)
      .map((n) => ({ id: n.id, name: n.name })),
    documents: docs,
  };
}

/** Recherche "Serveur / IP" : serveurs correspondants et applications hébergées. */
function searchServers(repo, q, limit = 30, ctx = null) {
  const query = String(q || '').trim();
  const nodes = query ? [...new Map([...repo.resolve(query), ...repo.search(query, limit)].map((n) => [n.id, n])).values()] : repo.listByType('server');
  return nodes
    .filter((n) => n.type === 'server')
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      name: s.name,
      attrs: s.attrs,
      env: serverEnv(s),
      retired: isRetired(s),
      state: serverState(ctx, s.id),
      applications: [...new Set(repo.edgesTo(s.id).filter((e) => e.type === 'runs_on' && !isRetired(e)).map((e) => e.src))]
        .map((id) => repo.getNode(id))
        .filter(Boolean)
        .map((a) => ({ id: a.id, name: a.name, criticality: appCriticality(a) })),
    }));
}

/** Page Équipe : applications regroupées par équipe support (ou responsable). */
function listTeams(repo) {
  const teams = new Map();
  for (const a of listApplications(repo)) {
    const key = a.supportTeam || a.owner || 'Non renseignée';
    if (!teams.has(key)) teams.set(key, { name: key, owners: new Set(), applications: [] });
    const t = teams.get(key);
    if (a.owner) t.owners.add(a.owner);
    t.applications.push({ id: a.id, name: a.name, criticality: a.criticality });
  }
  return [...teams.values()]
    // unassigned : l'interface affiche « Non renseignée » / « Not specified » selon sa langue
    .map((t) => ({ ...t, owners: [...t.owners], unassigned: t.name === 'Non renseignée' }))
    .sort((a, b) => a.unassigned - b.unassigned || b.applications.length - a.applications.length);
}

/** Configuration utile au front (liens externes, sources branchées). */
function uiConfig(env = process.env, extra = null) {
  return {
    ...(extra || {}),
    naemonUrlTemplate: env.NAEMON_URL_TEMPLATE || null, // ex : https://naemon.interne/thruk/#cgi-bin/status.cgi?hostgroup={app}
    sources: {
      servicenow: env.SOURCE_SERVICENOW === 'true',
      bitbucket: env.SOURCE_BITBUCKET === 'true',
    },
  };
}

module.exports = { serverState, appStatus, isRetired, listApplications, applicationDetail, applicationSummary, searchServers, listTeams, uiConfig, linkedNodes };
