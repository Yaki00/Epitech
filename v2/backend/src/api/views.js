'use strict';
/**
 * Vues "prêtes à afficher" pour le frontend, sans dépendance à Express
 * (testées directement par jest).
 */

const { serverEnv, appCriticality, ENVS } = require('../lib/environment');
const { docScore } = require('../quality/docScore');
const { isInactiveEdge } = require('../graph/impact');
const { nodeKey } = require('../store/repo');

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
  const serverIds = new Set(out.filter((e) => e.type === 'runs_on' && !isInactiveEdge(e)).map((e) => e.dst));
  const dbIds = new Set(out.filter((e) => e.type === 'uses_db' && !isInactiveEdge(e)).map((e) => e.dst));
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

const mark = (e, k) => (e.attrs && e.attrs[k]) || null;

/**
 * Liens sortants d'un type donné (ou entrants avec `incoming`), avec le nœud lié détaillé (onglets Serveurs, Bases, Flux).
 * Les liens inactifs (anciens, cibles, à valider) sont listés avec leurs marques (`trust`, `period`) et
 * `active: false` : l'interface les grise, ils ne comptent pas comme actifs.
 */
function linkedNodes(repo, id, edgeType, ctx = null, { incoming = false } = {}) {
  const byDst = new Map(); // nœud lié -> ses liens (cible des liens sortants, ou source des liens entrants)
  for (const e of (incoming ? repo.edgesTo(id) : repo.edgesFrom(id)).filter((x) => x.type === edgeType)) {
    const other = incoming ? e.src : e.dst;
    if (!byDst.has(other)) byDst.set(other, []);
    byDst.get(other).push(e);
  }
  const rank = (e) => (isInactiveEdge(e) ? (isRetired(e) ? 0 : 1) : 2); // actif > inactif > retiré
  return [...byDst.entries()]
    .map(([dst, edges]) => {
      const n = repo.getNode(dst);
      if (!n) return null;
      const best = edges.slice().sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence)[0];
      const active = !isRetired(n) && edges.some((e) => !isInactiveEdge(e));
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        attrs: n.attrs,
        retired: isRetired(n) || !active, // l'interface actuelle ne filtre que sur retired : un lien inactif y est grisé
        active,
        trust: mark(best, 'trust'),
        period: mark(best, 'period'),
        ...(n.type === 'server' ? { env: serverEnv(n), state: serverState(ctx, n.id), outOfInventory: Boolean(n.attrs.outOfInventory) } : {}),
        confidence: best.confidence,
        sources: [...new Set(edges.map((e) => e.source))],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Pages qui ont fourni un lien de responsable ou d'équipe (docId posé par la lecture). */
function docsOf(repo, ids) {
  return [...new Set(ids.filter(Boolean))]
    .map((d) => repo.getNode(d))
    .filter(Boolean)
    .map((d) => ({ id: d.id, title: d.name, url: d.attrs.url || null }));
}

/**
 * Responsables et équipes d'une application : ceux lus dans la documentation (liens owned_by) puis ceux
 * de l'APM (attrs owner / supportTeam). `source` : 'doc' ou 'apm' ; les actuels d'abord, les anciens ensuite.
 */
function ownersOfApp(repo, app) {
  const found = new Map(); // nature + nom normalisé -> entrée
  const keyOf = (kind, name) => `${kind}:${nodeKey(kind, name)}`;
  for (const e of repo.edgesFrom(app.id).filter((x) => x.type === 'owned_by' && !isRetired(x))) {
    const n = repo.getNode(e.dst);
    if (!n || isRetired(n)) continue;
    const role = mark(e, 'role') || 'other';
    // période absente (anciennes données) : actuelle ; null (page de période illisible) : inconnue, jamais actuelle
    const period = e.attrs && e.attrs.period === null ? null : mark(e, 'period') || 'current';
    const k = `${keyOf(n.type, n.name)}|${role}`;
    const prev = found.get(k);
    if (prev) {
      if (period === 'current') prev.period = 'current';
      prev.docIds.push(mark(e, 'docId'));
    } else {
      found.set(k, { id: n.id, name: n.name, kind: n.type, role, period, source: 'doc', docIds: [mark(e, 'docId')] });
    }
  }
  const docKeys = new Set([...found.values()].map((o) => keyOf(o.kind, o.name)));
  for (const [attr, kind, role] of [['owner', 'person', 'owner'], ['supportTeam', 'team', 'support']]) {
    const name = app.attrs[attr];
    if (!name || docKeys.has(keyOf(kind, name))) continue; // déjà connu par la documentation
    const node = repo.getNode(`${kind}:${nodeKey(kind, name)}`);
    found.set(`apm:${attr}`, { id: node ? node.id : null, name: String(name), kind, role, period: 'current', source: 'apm', docIds: [] });
  }
  return [...found.values()]
    .map(({ docIds, ...o }) => ({ ...o, docs: docsOf(repo, docIds) }))
    .sort((a, b) => Number(a.period !== 'current') - Number(b.period !== 'current') || a.name.localeCompare(b.name));
}

/** Fiche complète d'une application. */
function applicationDetail(repo, id, ctx = null) {
  const app = repo.getNode(id);
  if (!app || app.type !== 'application') return null;
  // une page peut être rattachée par plusieurs sources : une seule entrée, avec son rôle (sujet ou citée) et son contrôle d'architecture
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
      role: prev?.role === 'subject' ? 'subject' : mark(e, 'role') || prev?.role || null,
      // la période est lue sur la page (nœud document), un lien peut la préciser
      period: mark(e, 'period') || prev?.period || d.attrs.period || null,
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
    // applications qui appellent celle-ci : mêmes marques que callsList (un appel inactif est grisé, non compté)
    usedBy: linkedNodes(repo, id, 'calls', null, { incoming: true }),
    documents: docs,
    owners: ownersOfApp(repo, app),
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
      outOfInventory: Boolean(s.attrs.outOfInventory),
      state: serverState(ctx, s.id),
      applications: [...new Set(repo.edgesTo(s.id).filter((e) => e.type === 'runs_on' && !isInactiveEdge(e)).map((e) => e.src))]
        .map((id) => repo.getNode(id))
        .filter(Boolean)
        .map((a) => ({ id: a.id, name: a.name, criticality: appCriticality(a) })),
    }));
}

/**
 * Page Équipe : applications regroupées par personne ou équipe (documentation et APM), puis un groupe
 * `unassigned` pour les applications sans responsable actuel (`formerOnly` : seulement d'anciens responsables).
 * Le plus d'applications d'abord, `unassigned` en dernier.
 */
function listTeams(repo) {
  const groups = new Map();
  const unassigned = [];
  for (const app of repo.listByType('application').filter((a) => !isRetired(a))) {
    const owners = ownersOfApp(repo, app);
    const base = { id: app.id, name: app.name, criticality: appCriticality(app) };
    // sans responsable actuel (ni de période inconnue) : « Non renseignée » ; avec seulement d'anciens
    // responsables, l'application reste aussi sur leur carte (montrée comme ancienne) et porte `formerOnly`
    const current = owners.some((o) => o.period === 'current' || o.period === null);
    if (!current) unassigned.push({ ...base, role: null, period: null, source: null, docs: [], ...(owners.some((o) => o.period === 'past') ? { formerOnly: true } : {}) });
    if (!owners.length) continue;
    for (const o of owners) {
      const key = `${o.kind}:${nodeKey(o.kind, o.name)}`;
      if (!groups.has(key)) groups.set(key, { id: o.id, name: o.name, kind: o.kind, applications: [] });
      const g = groups.get(key);
      if (!g.id && o.id) g.id = o.id;
      const entry = { ...base, role: o.role, period: o.period, source: o.source, docs: o.docs };
      const at = g.applications.findIndex((x) => x.id === app.id);
      if (at === -1) g.applications.push(entry);
      else if (g.applications[at].period !== 'current' && o.period === 'current') g.applications[at] = entry; // l'actuel l'emporte
    }
  }
  const out = [...groups.values()].sort((a, b) => b.applications.length - a.applications.length || a.name.localeCompare(b.name));
  if (unassigned.length) out.push({ id: null, name: '', kind: 'unassigned', applications: unassigned });
  return out;
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

module.exports = { serverState, appStatus, isRetired, listApplications, applicationDetail, applicationSummary, searchServers, listTeams, uiConfig, linkedNodes, ownersOfApp };
