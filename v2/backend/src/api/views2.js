'use strict';
/**
 * Vues de l'API v2 (tableau de bord, états, écarts, historique, fiche serveur, simulation, carte).
 * Sans dépendance à Express : testées via l'API (api2.test.js). Toutes acceptent l'absence de supervision
 * ou d'historique (NAEMON_SOURCE=off) sans jamais fabriquer de zéro trompeur : les états sont alors « unknown ».
 *
 * Contexte `d` : { repo, poller, history, config, jobs }. `poller.snapshot()` ->
 * { status, source, lastOk, lastError, nextAt }.
 */
const { serverEnv, appCriticality, normalizeEnv } = require('../lib/environment');
const { impactOf } = require('../graph/impact');
const { computeGaps } = require('../naemon/gaps');
const { docScore } = require('../quality/docScore');
const views = require('./views');

const { isRetired, serverState, appStatus } = views;
const ALERT_STATES = { down: 3, critical: 2, warning: 1 };
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

/** Instantané de supervision ; jamais null. */
function snap(d) {
  const s = d.poller ? d.poller.snapshot() : null;
  return {
    status: (s && s.status) || null,
    source: s ? s.source || 'off' : 'off',
    lastOk: (s && s.lastOk) || null,
    lastError: (s && s.lastError) || null,
    nextAt: (s && s.nextAt) || null,
  };
}

const ctxOf = (d) => ({ status: snap(d).status });

function statusView(d) {
  const s = snap(d);
  const st = s.status;
  return {
    source: s.source,
    fetchedAt: (st && st.fetchedAt) || null,
    lastOk: s.lastOk,
    lastError: s.lastError,
    nextAt: s.nextAt,
    servers: (st && st.servers) || {},
    apps: (st && st.apps) || {},
    atRisk: (st && st.atRisk) || {},
    unmatchedHosts: (st && st.unmatchedHosts) || [],
  };
}

/** Applications suivies : celles du périmètre, ou toutes (hors retirées) si aucun périmètre n'est défini. */
function trackedApps(repo) {
  const all = repo.listByType('application').filter((a) => !isRetired(a));
  const inPerimeter = all.filter((a) => a.attrs.perimeter);
  return inPerimeter.length ? inPerimeter : all;
}

const serverLite = (repo, id, extra = {}) => {
  const n = repo.getNode(id);
  return n && { id: n.id, name: n.name, env: serverEnv(n), ip: (n.attrs && n.attrs.ip) || null, ...extra };
};

function gapsView(d) {
  const { repo } = d;
  const st = snap(d).status;
  const g = computeGaps(repo, st);
  const out = {
    available: Boolean(st),
    notMonitored: g.notMonitored.map((n) => serverLite(repo, n.id)),
    unknownMonitored: g.unknownMonitored,
    citedNotInInventory: g.citedNotInInventory,
  };
  out.counts = { notMonitored: out.notMonitored.length, unknownMonitored: out.unknownMonitored.length, citedNotInInventory: out.citedNotInInventory.length };
  return { gaps: out, raw: g };
}

/** Noms lisibles des identifiants d'une entrée d'historique (nœuds et liens src|dst|type|source). */
function withLabels(repo, entry) {
  const labels = {};
  const note = (id) => {
    const n = repo.getNode(id);
    if (n) labels[id] = n.name;
  };
  const edgeEnds = (id) => String(id).split('|').slice(0, 2);
  for (const id of [...entry.added, ...entry.removed]) (String(id).includes('|') ? edgeEnds(id) : [id]).forEach(note);
  for (const c of entry.changed) note(c.id);
  return { ...entry, labels };
}

function changesView(d, limit = 20) {
  if (!d.history) return [];
  return d.history.list(limit).map((e) => withLabels(d.repo, e));
}

function sourcesView(d) {
  const { repo, config } = d;
  const s = snap(d);
  const demo = Boolean(config && config.demo);
  const out = [];
  if (demo) {
    const last = d.history ? d.history.list(1)[0] : null;
    for (const source of ['apm', 'confluence']) out.push({ source, lastRun: last ? last.at : null, status: 'démo' });
  } else {
    const seen = new Set();
    for (const r of repo.lastRuns(200)) {
      if (seen.has(r.source)) continue;
      seen.add(r.source);
      out.push({ source: r.source, lastRun: r.finished_at || r.started_at || null, status: r.status });
    }
  }
  let nStatus = 'pending';
  if (demo) nStatus = 'démo';
  else if (s.source === 'off') nStatus = 'off';
  else if (s.lastError) nStatus = 'error';
  else if (s.lastOk) nStatus = 'ok';
  out.push({ source: 'naemon', lastRun: s.lastOk, status: nStatus });
  return out;
}

function overviewView(d) {
  const { repo } = d;
  const ctx = ctxOf(d);
  const s = snap(d);
  const apps = trackedApps(repo);
  const appRows = apps
    .map((a) => ({ id: a.id, name: a.name, state: appStatus(ctx, a.id).state, criticality: appCriticality(a), docScore: docScore(repo, a.id).score }))
    .sort(byName);

  // serveurs suivis -> applications qui les hébergent
  const hostedBy = new Map();
  for (const a of apps) {
    for (const e of repo.edgesFrom(a.id)) {
      if (e.type !== 'runs_on' || isRetired(e)) continue;
      if (!hostedBy.has(e.dst)) hostedBy.set(e.dst, []);
      hostedBy.get(e.dst).push({ id: a.id, name: a.name });
    }
  }
  const alerts = [];
  for (const [serverId, hosts] of hostedBy) {
    const srv = repo.getNode(serverId);
    const st = ctx.status && ctx.status.servers[serverId];
    if (!srv || isRetired(srv) || !st || !ALERT_STATES[st.state]) continue;
    alerts.push({ serverId, name: srv.name, state: st.state, output: st.output || '', ack: Boolean(st.ack), apps: hosts.sort(byName) });
  }
  alerts.sort((a, b) => Number(a.ack) - Number(b.ack) || ALERT_STATES[b.state] - ALERT_STATES[a.state] || byName(a, b));

  const label = (id) => (repo.getNode(id) && repo.getNode(id).name) || id;
  const atRisk = Object.entries((ctx.status && ctx.status.atRisk) || {})
    .map(([appId, r]) => ({ appId, name: label(appId), because: { id: r.because, name: label(r.because) }, path: r.path.map((id) => ({ id, name: label(id) })) }))
    .sort(byName);

  const servers = repo.listByType('server').filter((n) => !isRetired(n));
  const serversByEnv = { PRD: 0, STG: 0, DEV: 0, unspecified: 0 };
  for (const n of servers) serversByEnv[serverEnv(n) || 'unspecified']++;
  const counts = {
    applications: apps.length,
    servers: servers.length,
    serversByEnv,
    retiredServers: repo.listByType('server').length - servers.length,
    databases: repo.listByType('database').filter((n) => !isRetired(n)).length,
    documents: repo.listByType('document').filter((n) => !isRetired(n)).length,
  };

  return {
    counts,
    apps: appRows,
    alerts,
    atRisk,
    sources: sourcesView(d),
    recentChanges: changesView(d, 5),
    gaps: { counts: gapsView(d).gaps.counts, available: Boolean(ctx.status) },
    lowestDocs: appRows
      .slice()
      .sort((a, b) => a.docScore - b.docScore || byName(a, b))
      .slice(0, 3)
      .map((a) => ({ id: a.id, name: a.name, docScore: a.docScore })),
    naemon: { source: s.source, lastOk: s.lastOk, lastError: s.lastError },
  };
}

/** Fiche serveur ; null si l'identifiant n'est pas un serveur. */
function serverDetail(d, id) {
  const { repo } = d;
  const n = repo.getNode(id);
  if (!n || n.type !== 'server') return null;
  const ctx = ctxOf(d);
  const st = (ctx.status && ctx.status.servers[id]) || null;
  const applications = [...new Set(repo.edgesTo(id).filter((e) => e.type === 'runs_on' && !isRetired(e)).map((e) => e.src))]
    .map((x) => repo.getNode(x))
    .filter(Boolean)
    .map((a) => ({ id: a.id, name: a.name, criticality: appCriticality(a), state: appStatus(ctx, a.id).state }))
    .sort(byName);
  const documents = [...new Set(repo.edgesTo(id).filter((e) => e.type === 'mentions' && !isRetired(e)).map((e) => e.src))]
    .map((x) => repo.getNode(x))
    .filter((x) => x && x.type === 'document' && !isRetired(x))
    .map((x) => ({ id: x.id, name: x.name, url: x.attrs.url || null, architecture: x.attrs.pageKind === 'architecture' }))
    .sort(byName);
  const touches = (x) => x === id || (String(x).includes('|') && String(x).split('|').slice(0, 2).includes(id));
  const changes = (d.history ? d.history.list(50) : [])
    .map((e) => ({ at: e.at, source: e.source, added: e.added.filter(touches), removed: e.removed.filter(touches), changed: e.changed.filter((c) => c.id === id) }))
    .filter((e) => e.added.length || e.removed.length || e.changed.length);
  return {
    id: n.id,
    name: n.name,
    attrs: n.attrs,
    env: serverEnv(n),
    retired: isRetired(n),
    state: serverState(ctx, id),
    ack: st ? st.ack : false,
    output: st ? st.output : '',
    lastCheck: st ? st.lastCheck : null,
    services: st ? st.services : [],
    applications,
    documents,
    changes,
  };
}

/** Panne simulée de plusieurs éléments : union des impacts (sans les éléments d'origine). */
function simulate(d, nodeIds, { includeRetired = false, depth = 5, minConfidence = 0.5 } = {}) {
  const { repo } = d;
  const origin = new Set(nodeIds);
  const best = new Map();
  const unknown = [];
  for (const id of origin) {
    const r = impactOf(repo, id, { maxDepth: depth, minConfidence, includeRetired });
    if (!r) {
      unknown.push(id);
      continue;
    }
    for (const it of r.items) {
      if (origin.has(it.id)) continue;
      const prev = best.get(it.id);
      if (!prev || it.depth < prev.depth) best.set(it.id, { id: it.id, name: it.name, type: it.type, depth: it.depth, via: it.via });
    }
  }
  const impacted = [...best.values()].sort((a, b) => a.depth - b.depth || byName(a, b));
  const byType = {};
  for (const i of impacted) (byType[i.type] ||= []).push(i.id);
  return { impacted, byType, unknown };
}

/** Graphe à afficher. `scope` : perimeter ou app:<id>. Renvoie null si l'application est inconnue. */
function mapView(d, { scope = 'perimeter', envs = null, includeRetired = false } = {}) {
  const { repo } = d;
  const ctx = ctxOf(d);
  const wanted = new Set((envs || []).map(normalizeEnv).filter(Boolean));
  if (!wanted.size) ['PRD', 'STG'].forEach((e) => wanted.add(e));
  const keep = (x) => includeRetired || !isRetired(x);

  let focus;
  const extraApps = new Set();
  if (scope === 'perimeter') {
    focus = trackedApps(repo);
  } else {
    const app = repo.getNode(scope.slice(4).startsWith('application:') ? scope.slice(4) : `application:${scope.slice(4)}`);
    if (!app || app.type !== 'application') return null;
    focus = [app];
    for (const e of repo.edgesFrom(app.id)) if (e.type === 'calls' && keep(e)) extraApps.add(e.dst);
    for (const e of repo.edgesTo(app.id)) if (e.type === 'calls' && keep(e)) extraApps.add(e.src);
  }

  const nodes = new Map();
  const add = (n) => n && keep(n) && nodes.set(n.id, n);
  for (const a of focus) add(a);
  for (const id of extraApps) add(repo.getNode(id));
  for (const a of focus) {
    for (const e of repo.edgesFrom(a.id)) {
      if (!keep(e) || (e.type !== 'runs_on' && e.type !== 'uses_db')) continue;
      const n = repo.getNode(e.dst);
      if (!n) continue;
      if (n.type === 'server') {
        const env = serverEnv(n);
        if (env && !wanted.has(env)) continue; // sans environnement : toujours montré (zone « Non précisé »)
      }
      add(n);
    }
  }

  const edges = new Map();
  const hosts = new Map();
  for (const id of nodes.keys()) {
    if (nodes.get(id).type !== 'application') continue;
    for (const e of repo.edgesFrom(id)) {
      if (!['runs_on', 'uses_db', 'calls'].includes(e.type) || !keep(e) || !nodes.has(e.dst)) continue;
      const k = `${e.src}|${e.dst}|${e.type}`;
      const prev = edges.get(k);
      if (prev) prev.retired = prev.retired && isRetired(e);
      else edges.set(k, { id: String(e.id), source: e.src, target: e.dst, type: e.type, retired: isRetired(e) });
      if (e.type === 'runs_on') {
        if (!hosts.has(e.dst)) hosts.set(e.dst, new Set());
        hosts.get(e.dst).add(e.src);
      }
    }
  }

  const nodeOut = [...nodes.values()]
    .map((n) => ({
      id: n.id,
      type: n.type,
      label: n.name,
      env: n.type === 'server' ? serverEnv(n) : null,
      state: n.type === 'server' ? serverState(ctx, n.id) : n.type === 'application' ? appStatus(ctx, n.id).state : null,
      criticality: n.type === 'application' ? appCriticality(n) : null,
      retired: isRetired(n),
      appIds: n.type === 'server' ? [...(hosts.get(n.id) || [])].sort() : [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { nodes: nodeOut, edges: [...edges.values()] };
}

module.exports = { statusView, gapsView, changesView, overviewView, serverDetail, simulate, mapView, snap, ctxOf };
