'use strict';
/**
 * Vérification par le code d'une lecture IA (type Reading) : citations retrouvées dans le texte,
 * rapprochement avec l'inventaire et le périmètre, règles de confiance. Ne modifie rien :
 * seule la lecture du graphe est faite. Voir docs/2026-11-23-v2-reperage-ia-conception.md.
 *
 * Verified = {
 *   kind, period, env, topics,
 *   apps: [{ appId, role, written, evidence }],
 *   servers: [{ nodeId|null, name, ip|null, env, status, inInventory, corroborated, evidence }],
 *   links: [{ src, dst, srcName, dstName, type, trust, period, evidence }],
 *   owners: [{ appId, name, kind, role, period, evidence }],
 *   rejected: [{ what, reason: 'no_evidence'|'unknown_application'|'out_of_scope' }],
 * }
 * src/dst : identifiant du nœud s'il existe, sinon `type:clé` du nœud à créer.
 */
const { hasEvidence } = require('./evidence');
const { normKey } = require('./schema');
const { serverEnv } = require('../lib/environment');
const { nodeKey } = require('../store/repo');

const CORROBORATION_DAYS = 730;
const DAY = 86400000;
/** Sources de liens issues de la documentation : toute autre source est un inventaire. */
const DOC_SOURCES = new Set(['confluence', 'drawio', 'llm', 'reading', 'manual', 'perimeter']);

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);

function verifyReading(reading, ctx) {
  const { repo, matcher, naemonHosts = new Set(), pageUpdatedAt = null, now = Date.now() } = ctx;
  const docSources = ctx.docSources || DOC_SOURCES;
  const text = `${ctx.pageText || ''}\n${ctx.diagramsText || ''}`;
  const rejected = [];
  const ok = (what, evidence) => {
    if (hasEvidence(text, evidence)) return true;
    rejected.push({ what, reason: 'no_evidence' });
    return false;
  };

  const page = reading.page || {};
  const pagePeriod = page.period === undefined ? 'current' : page.period; // null = illisible
  const pageReliable = pagePeriod !== null;
  const recentPage = pagePeriod === 'current' && pageUpdatedAt && now - Date.parse(pageUpdatedAt) < CORROBORATION_DAYS * DAY;

  // ---- applications ----
  const openApps = new Map(); // applications hors périmètre acceptées (ignoreOtherApplications faux)
  const appIdOf = (name) => {
    const hit = matcher && matcher.resolveAppName(name);
    return hit ? hit.app.id : openApps.get(normKey(name)) || null;
  };
  const apps = [];
  for (const a of reading.applications || []) {
    if (!ok(a.name, a.evidence)) continue;
    let appId = appIdOf(a.name);
    if (!appId) {
      if (!matcher || matcher.ignoreOthers) {
        rejected.push({ what: a.name, reason: 'out_of_scope' });
        continue;
      }
      appId = `application:${nodeKey('application', a.name)}`;
      openApps.set(normKey(a.name), appId);
    }
    apps.push({ appId, role: a.role, written: a.written, evidence: a.evidence });
  }

  // ---- entités ----
  const entityByKey = new Map(); // clé normalisée du nom -> entité vérifiée (serveur résolu ou non)
  const servers = [];
  const serverByKey = new Map(); // nodeId ou nom -> entrée de `servers`
  const naemonLower = new Set([...naemonHosts].map((h) => String(h).toLowerCase()));

  function inventoryOwners(serverId) {
    return new Set(repo.edgesTo(serverId).filter((e) => e.type === 'runs_on' && !isRetired(e) && !docSources.has(e.source)).map((e) => e.src));
  }
  const resolveServer = (name) => repo.resolve(name).find((n) => n.type === 'server') || null;
  function isSupervised(name, node) {
    const names = [name, node && node.name, node && node.attrs && node.attrs.fqdn].filter(Boolean).map((s) => String(s).toLowerCase());
    const isIp = (n) => /^\d{1,3}(\.\d{1,3}){3}$/.test(n);
    return names.some((n) => naemonLower.has(n) || (!isIp(n) && naemonLower.has(n.split('.')[0])));
  }

  function addServer(k, name, node, e) {
    const attrs = (node && node.attrs) || {};
    const hasRow = Object.keys(attrs).some((k) => k.endsWith('_row') && k !== 'confluence_row');
    const inInventory = Boolean(node && !isRetired(node) && !attrs.outOfInventory && (hasRow || inventoryOwners(node.id).size > 0));
    const entry = {
      nodeId: node ? node.id : null,
      name: node ? node.name : name,
      env: (e && e.env) || (node ? serverEnv(node) : null) || page.env || null,
      status: e && e.status !== undefined ? e.status : 'active',
      ip: (e && e.ip) || null,
      inInventory,
      corroborated: false,
      evidence: e ? e.evidence : '',
    };
    if (!inInventory) entry.corroborated = isSupervised(name, node) || Boolean(recentPage && entry.status === 'active');
    serverByKey.set(k, entry);
    servers.push(entry);
    return entry;
  }

  for (const e of reading.entities || []) {
    if (e.type === 'person' || e.type === 'team') continue;
    if (!ok(e.name, e.evidence)) continue;
    if (e.type === 'server' || e.type === 'ip') {
      const node = resolveServer(e.name);
      const k = node ? node.id : `name:${normKey(e.name)}`;
      const entry = serverByKey.get(k) || addServer(k, e.name, node, e);
      entityByKey.set(normKey(e.name), { kind: 'server', entry, node });
    } else {
      entityByKey.set(normKey(e.name), { kind: e.type, name: e.name });
    }
  }

  // ---- liens ----
  /** Extrémité d'un lien : { id, kind, entry? } ou null. */
  function endpoint(name) {
    const ent = entityByKey.get(normKey(name));
    if (ent && ent.kind === 'server') return { id: ent.entry.nodeId || `server:${nodeKey('server', name)}`, kind: 'server', entry: ent.entry, name: ent.entry.name };
    if (ent) return { id: `${ent.kind}:${nodeKey(ent.kind, ent.name)}`, kind: ent.kind, name: ent.name };
    const appId = appIdOf(name);
    if (appId) return { id: appId, kind: 'application', name };
    const node = resolveServer(name);
    if (node) {
      return { id: node.id, kind: 'server', entry: serverByKey.get(node.id) || addServer(node.id, name, node, null) };
    }
    const other = repo.resolve(name)[0];
    if (other) return { id: other.id, kind: other.type };
    return null;
  }

  const links = [];
  for (const l of reading.links || []) {
    if (!ok(`${l.from} ${l.type} ${l.to}`, l.evidence)) continue;
    const from = endpoint(l.from);
    const to = endpoint(l.to);
    if (!from || !to) {
      rejected.push({ what: `${l.from} ${l.type} ${l.to}`, reason: 'out_of_scope' });
      continue;
    }
    let trust = 'added';
    let period = pageReliable ? pagePeriod : 'current';
    const entry = to.entry || from.entry;
    if (l.type === 'runs_on' && from.kind === 'application' && to.kind === 'server') {
      const owners = to.entry && to.entry.nodeId ? inventoryOwners(to.entry.nodeId) : new Set();
      if (owners.has(from.id)) trust = 'confirmed';
      else if (owners.size) trust = 'otherApp';
      else trust = to.entry && to.entry.corroborated ? 'added' : 'toValidate';
    }
    if (entry && entry.status === 'decommissioned' && period === 'current') period = 'past';
    if (entry && entry.status === 'planned' && period === 'current') period = 'target';
    const unreadable = !pageReliable || (entry && entry.status === null && l.type === 'runs_on');
    if (unreadable && trust !== 'confirmed' && trust !== 'otherApp') trust = 'toValidate';
    links.push({ src: from.id, dst: to.id, srcName: from.name || l.from, dstName: to.name || l.to, type: l.type, trust, period, evidence: l.evidence });
  }

  // ---- responsables ----
  const owners = [];
  for (const o of reading.owners || []) {
    if (!ok(o.name, o.evidence)) continue;
    const appId = o.application ? appIdOf(o.application) : null;
    if (!appId) {
      rejected.push({ what: o.name, reason: 'unknown_application' });
      continue;
    }
    owners.push({ appId, name: o.name, kind: o.kind, role: o.role, period: pageReliable ? pagePeriod : 'current', evidence: o.evidence });
  }

  return { kind: page.kind, period: page.period === undefined ? 'current' : page.period, env: page.env || null, topics: page.topics || [], apps, servers, links, owners, rejected };
}

module.exports = { verifyReading };
