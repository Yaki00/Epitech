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
 *   ips: [{ ip, status, evidence }],   IP citées sans serveur connu (aucun nœud créé)
 *   links: [{ src, dst, srcName, dstName, type, trust, period, evidence }],
 *   owners: [{ appId, name, kind, role, period (null : page de période illisible), evidence }],
 *   rejected: [{ what, reason: 'no_evidence'|'evidence_mismatch'|'unknown_application'|'out_of_scope' }],
 * }
 * Une citation doit se retrouver dans la page (`no_evidence`) ET nommer l'élément : nom ou forme écrite,
 * nom court ou FQDN d'un serveur, une des deux extrémités d'un lien (`evidence_mismatch`).
 * Confiance d'un lien vers un serveur : runs_on suit le tableau de la conception (confirmed, otherApp,
 * added, toValidate) ; tout autre lien vers un serveur hors inventaire non corroboré, ou rattaché dans
 * l'inventaire à une autre application que celle du lien (ou de la page), est `toValidate`.
 * src/dst : identifiant du nœud s'il existe, sinon `type:clé` du nœud à créer.
 */
const { hasEvidence, quoteNames } = require('./evidence');
const { canonicalHost } = require('../resolve/entities');
const { normKey } = require('./schema');
const { serverEnv } = require('../lib/environment');
const { nodeKey } = require('../store/repo');

const CORROBORATION_DAYS = 730;
const DAY = 86400000;
/** Sources de liens issues de la documentation : toute autre source est un inventaire. */
const DOC_SOURCES = new Set(['confluence', 'drawio', 'llm', 'reading', 'manual', 'perimeter']);

/** Types de nœuds qu'une extrémité de lien peut désigner. */
const LINK_END_TYPES = new Set(['server', 'application', 'database', 'url', 'queue', 'path']);

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
  /** La citation doit nommer l'élément (une phrase générale de la page ne prouve rien). */
  const tied = (what, evidence, names) => {
    if (quoteNames(evidence, names)) return true;
    rejected.push({ what, reason: 'evidence_mismatch' });
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
  const writtenByApp = new Map(); // appId -> formes écrites dans la page
  /** Noms sous lesquels une application peut être citée : nom, formes écrites, variantes du périmètre. */
  function appNames(appId) {
    const out = [...(writtenByApp.get(appId) || [])];
    const app = matcher && matcher.apps.find((a) => a.id === appId);
    if (app) out.push(app.name, ...app.variants.map((v) => v.text), app.sigle, app.auid);
    const node = repo.getNode(appId);
    if (node) out.push(node.name);
    return out.filter(Boolean);
  }
  const apps = [];
  for (const a of reading.applications || []) {
    if (!ok(a.name, a.evidence)) continue;
    const known = appIdOf(a.name);
    if (!tied(a.name, a.evidence, [a.name, a.written, ...(known ? appNames(known) : [])])) continue;
    let appId = known;
    if (!appId) {
      if (!matcher || matcher.ignoreOthers) {
        rejected.push({ what: a.name, reason: 'out_of_scope' });
        continue;
      }
      appId = `application:${nodeKey('application', a.name)}`;
      openApps.set(normKey(a.name), appId);
    }
    if (!writtenByApp.has(appId)) writtenByApp.set(appId, new Set());
    writtenByApp.get(appId).add(a.name).add(a.written);
    apps.push({ appId, role: a.role, written: a.written, evidence: a.evidence });
  }

  // ---- entités ----
  const entityByKey = new Map(); // clé normalisée du nom -> entité vérifiée (serveur résolu ou non)
  const servers = [];
  const ips = []; // IP citées qui ne désignent aucun serveur connu : gardées pour le contrôle, sans nœud
  const serverByKey = new Map(); // nodeId ou nom -> entrée de `servers`
  const naemonLower = new Set([...naemonHosts].map((h) => String(h).toLowerCase()));

  function inventoryOwners(serverId) {
    return new Set(repo.edgesTo(serverId).filter((e) => e.type === 'runs_on' && !isRetired(e) && !docSources.has(e.source)).map((e) => e.src));
  }
  const resolveServer = (name) => repo.resolve(name).find((n) => n.type === 'server') || null;
  /** Noms d'un serveur : nom donné, nom court d'un FQDN (et inversement), nom, FQDN et IP du nœud. */
  function serverNames(name, node) {
    const a = (node && node.attrs) || {};
    const ipList = String(a.ip || '').split(/[,;|\s]+/);
    return [name, canonicalHost(name), node && node.name, a.fqdn, canonicalHost(a.fqdn), ...ipList].filter(Boolean);
  }
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

  const entities = (reading.entities || []).filter((e) => e.type !== 'person' && e.type !== 'team');
  // les IP en dernier : une IP donnée dans le champ `ip` d'un serveur de la page désigne ce serveur
  for (const e of [...entities.filter((x) => x.type !== 'ip'), ...entities.filter((x) => x.type === 'ip')]) {
    if (!ok(e.name, e.evidence)) continue;
    if (e.type === 'server' || e.type === 'ip') {
      const node = resolveServer(e.name);
      const names = [...serverNames(e.name, node), e.ip];
      if (!tied(e.name, e.evidence, names)) continue;
      if (e.type === 'ip' && !node) {
        const owner = servers.find((s) => s.ip === e.name);
        if (owner) entityByKey.set(normKey(e.name), { kind: 'server', entry: owner, node: owner.nodeId ? repo.getNode(owner.nodeId) : null });
        else if (!ips.some((x) => x.ip === e.name)) ips.push({ ip: e.name, status: e.status === undefined ? 'active' : e.status, evidence: e.evidence });
        continue;
      }
      const k = node ? node.id : `name:${normKey(e.name)}`;
      const entry = serverByKey.get(k) || addServer(k, e.name, node, e);
      entityByKey.set(normKey(e.name), { kind: 'server', entry, node });
    } else {
      if (!tied(e.name, e.evidence, [e.name])) continue;
      entityByKey.set(normKey(e.name), { kind: e.type, name: e.name });
    }
  }

  // ---- liens ----
  /** Noms sous lesquels une extrémité de lien peut être citée (sans rien créer). */
  function endNames(name) {
    const out = [name];
    const ent = entityByKey.get(normKey(name));
    if (ent && ent.kind === 'server') out.push(...serverNames(ent.entry.name, ent.node));
    else if (ent) out.push(ent.name);
    const appId = appIdOf(name);
    if (appId) out.push(...appNames(appId));
    const node = resolveServer(name);
    if (node) out.push(...serverNames(name, node));
    return out;
  }
  /** Extrémité d'un lien : { id, kind, entry? } ou null. */
  function endpoint(name) {
    const ent = entityByKey.get(normKey(name));
    if (ent && ent.kind === 'server') return { id: ent.entry.nodeId || `server:${nodeKey('server', ent.entry.name)}`, kind: 'server', entry: ent.entry, name: ent.entry.name };
    if (ent) return { id: `${ent.kind}:${nodeKey(ent.kind, ent.name)}`, kind: ent.kind, name: ent.name };
    const appId = appIdOf(name);
    if (appId) return { id: appId, kind: 'application', name };
    const node = resolveServer(name);
    if (node) {
      return { id: node.id, kind: 'server', entry: serverByKey.get(node.id) || addServer(node.id, name, node, null) };
    }
    const other = repo.resolve(name).find((n) => LINK_END_TYPES.has(n.type));
    if (other) return { id: other.id, kind: other.type };
    return null;
  }

  // applications auxquelles la page se rapporte : sujets, sinon toutes les applications citées
  const subjects = apps.filter((a) => a.role === 'subject').map((a) => a.appId);
  const pageApps = subjects.length ? subjects : apps.map((a) => a.appId);

  const links = [];
  for (const l of reading.links || []) {
    const what = `${l.from} ${l.type} ${l.to}`;
    if (!ok(what, l.evidence)) continue;
    if (!tied(what, l.evidence, [...endNames(l.from), ...endNames(l.to)])) continue;
    const from = endpoint(l.from);
    const to = endpoint(l.to);
    if (!from || !to) {
      rejected.push({ what, reason: 'out_of_scope' });
      continue;
    }
    let trust = 'added';
    let period = pageReliable ? pagePeriod : 'current';
    // extrémité serveur du lien (la cible d'abord) : l'inventaire reste la référence
    const srv = to.kind === 'server' ? to : from.kind === 'server' ? from : null;
    const other = srv === to ? from : to;
    const entry = srv && srv.entry;
    if (srv) {
      const owners = entry && entry.nodeId ? inventoryOwners(entry.nodeId) : new Set();
      if (l.type === 'runs_on' && from.kind === 'application' && srv === to) {
        if (owners.has(from.id)) trust = 'confirmed';
        else if (owners.size) trust = 'otherApp';
        else trust = entry && entry.corroborated ? 'added' : 'toValidate';
      } else if (owners.size) {
        // serveur d'une autre application de l'inventaire : à valider
        const linked = other.kind === 'application' ? [other.id] : pageApps;
        if (linked.length && !linked.some((id) => owners.has(id))) trust = 'toValidate';
      } else if (!(entry && (entry.inInventory || entry.corroborated))) {
        trust = 'toValidate'; // serveur hors inventaire que rien ne corrobore
      }
    }
    if (entry && entry.status === 'decommissioned' && period === 'current') period = 'past';
    if (entry && entry.status === 'planned' && period === 'current') period = 'target';
    const unreadable = !pageReliable || (entry && entry.status === null);
    if (unreadable && trust !== 'confirmed' && trust !== 'otherApp') trust = 'toValidate';
    links.push({ src: from.id, dst: to.id, srcName: from.name || l.from, dstName: to.name || l.to, type: l.type, trust, period, evidence: l.evidence });
  }

  // ---- responsables ----
  const owners = [];
  for (const o of reading.owners || []) {
    if (!ok(o.name, o.evidence)) continue;
    if (!tied(o.name, o.evidence, [o.name])) continue;
    const appId = o.application ? appIdOf(o.application) : null;
    if (!appId) {
      rejected.push({ what: o.name, reason: 'unknown_application' });
      continue;
    }
    // page de période illisible : période inconnue (null), jamais comptée comme actuelle
    owners.push({ appId, name: o.name, kind: o.kind, role: o.role, period: pageReliable ? pagePeriod : null, evidence: o.evidence });
  }

  return { kind: page.kind, period: page.period === undefined ? 'current' : page.period, env: page.env || null, topics: page.topics || [], apps, servers, ips, links, owners, rejected };
}

module.exports = { verifyReading, DOC_SOURCES };
