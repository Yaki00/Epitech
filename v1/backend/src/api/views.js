'use strict';
/**
 * Vues "prêtes à afficher" pour le frontend, sans dépendance à Express
 * (testées directement par jest).
 */

const splitList = (v) =>
  Array.isArray(v)
    ? v
    : String(v || '')
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);

/** Résumé d'une application : compteurs et infos de la fiche. */
function applicationSummary(repo, app) {
  const out = repo.edgesFrom(app.id);
  const serverIds = new Set(out.filter((e) => e.type === 'runs_on').map((e) => e.dst));
  const dbIds = new Set(out.filter((e) => e.type === 'uses_db').map((e) => e.dst));
  const envs = new Set(splitList(app.attrs.environments || app.attrs.environment));
  for (const id of serverIds) {
    const s = repo.getNode(id);
    for (const env of splitList(s?.attrs.environment)) envs.add(env.toUpperCase());
  }
  return {
    id: app.id,
    name: app.name,
    inPerimeter: Boolean(app.attrs.perimeter),
    criticality: app.attrs.criticality || null,
    owner: app.attrs.owner || null,
    supportTeam: app.attrs.supportTeam || null,
    description: app.attrs.description || null,
    summary: app.attrs.summary || null,
    environments: [...envs],
    servers: serverIds.size,
    databases: dbIds.size,
    lastSync: app.updatedAt || null,
  };
}

function listApplications(repo) {
  return repo.listByType('application').map((a) => applicationSummary(repo, a));
}

/** Liens sortants d'un type donné, avec le nœud cible détaillé (onglets Serveurs / Bases). */
function linkedNodes(repo, id, edgeType) {
  const best = new Map();
  for (const e of repo.edgesFrom(id).filter((x) => x.type === edgeType)) {
    const prev = best.get(e.dst);
    if (prev && prev.confidence >= e.confidence) {
      prev.sources.add(e.source);
      continue;
    }
    best.set(e.dst, { confidence: e.confidence, sources: new Set([...(prev?.sources || []), e.source]) });
  }
  return [...best.entries()]
    .map(([dst, info]) => {
      const n = repo.getNode(dst);
      return n && { id: n.id, name: n.name, type: n.type, attrs: n.attrs, confidence: info.confidence, sources: [...info.sources] };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Fiche complète d'une application. */
function applicationDetail(repo, id) {
  const app = repo.getNode(id);
  if (!app || app.type !== 'application') return null;
  const docs = repo
    .edgesFrom(id)
    .filter((e) => e.type === 'documented_in')
    .map((e) => repo.getNode(e.dst))
    .filter(Boolean)
    .map((d) => ({ id: d.id, name: d.name, url: d.attrs.url || null }));
  return {
    ...applicationSummary(repo, app),
    attrs: app.attrs,
    serverList: linkedNodes(repo, id, 'runs_on'),
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
function searchServers(repo, q, limit = 30) {
  const query = String(q || '').trim();
  const nodes = query ? [...new Map([...repo.resolve(query), ...repo.search(query, limit)].map((n) => [n.id, n])).values()] : repo.listByType('server');
  return nodes
    .filter((n) => n.type === 'server')
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      name: s.name,
      attrs: s.attrs,
      applications: [...new Set(repo.edgesTo(s.id).filter((e) => e.type === 'runs_on').map((e) => e.src))]
        .map((id) => repo.getNode(id))
        .filter(Boolean)
        .map((a) => ({ id: a.id, name: a.name, criticality: a.attrs.criticality || null })),
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
    .map((t) => ({ ...t, owners: [...t.owners] }))
    .sort((a, b) => (a.name === 'Non renseignée') - (b.name === 'Non renseignée') || b.applications.length - a.applications.length);
}

/** Configuration utile au front (liens externes, sources branchées). */
function uiConfig(env = process.env) {
  return {
    naemonUrlTemplate: env.NAEMON_URL_TEMPLATE || null, // ex : https://naemon.interne/thruk/#cgi-bin/status.cgi?hostgroup={app}
    sources: {
      servicenow: env.SOURCE_SERVICENOW === 'true',
      bitbucket: env.SOURCE_BITBUCKET === 'true',
    },
  };
}

module.exports = { listApplications, applicationDetail, applicationSummary, searchServers, listTeams, uiConfig, linkedNodes };
