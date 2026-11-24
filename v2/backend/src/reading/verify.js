'use strict';
/**
 * Vérification par le code d'une lecture IA (type Reading) : citations retrouvées dans le texte,
 * rapprochement avec l'inventaire et le périmètre, règles de confiance. Ne modifie rien :
 * seule la lecture du graphe est faite. Voir docs/2026-11-23-v2-reperage-ia-conception.md.
 *
 * Verified = {
 *   kind, period, env, topics,          env : celui de la page, seulement si sa citation (envEvidence) se
 *                                       retrouve dans l'en-tête (titre, pages parentes : ctx.headerText) et
 *                                       contient un mot qui désigne cet environnement
 *   apps: [{ appId, role, written, evidence }],
 *   servers: [{ nodeId|null, name, ip|null, env, status, inInventory, corroborated, evidence }],
 *   ips: [{ ip, status, evidence }],   IP citées sans serveur connu (aucun nœud créé)
 *   links: [{ src, dst, srcName, dstName, type, trust, period, evidence }],
 *   owners: [{ appId, name, kind, role, period (null : page de période illisible), evidence }],
 *   rejected: [{ what, reason: 'no_evidence'|'evidence_mismatch'|'not_in_header'|'unknown_application'|'out_of_scope' }],
 * }
 * Une citation doit se retrouver dans la page (`no_evidence`) ET nommer l'élément : nom ou forme écrite,
 * nom court ou FQDN d'un serveur, une des deux extrémités d'un lien (`evidence_mismatch`).
 * Confiance d'un lien vers un serveur : runs_on suit le tableau de la conception (confirmed, otherApp,
 * added, toValidate) ; tout autre lien vers un serveur hors inventaire non corroboré, ou rattaché dans
 * l'inventaire à une autre application que celle du lien, est `toValidate`. Quand l'autre extrémité
 * n'est pas une application (base, file, URL...), ses applications sont celles qui l'utilisent (liens
 * uses_db actuels de la page ; uses_db, reads_from, writes_to actifs du graphe), puis celles de la page.
 * Un serveur hors inventaire est corroboré par Naemon, par cette page si elle est actuelle et récente
 * (moins de 24 mois) et le dit actif, ou par une autre page (ni celle-ci, ni un document retiré)
 * actuelle et récente qui le cite comme actif (liens mentions déjà écrits).
 * Un serveur hors inventaire qu'une autre page dit arrêté (page actuelle, ou plus récente que celle-ci)
 * est contesté : il n'est corroboré par rien (pas même Naemon, qui supervise parfois encore un serveur
 * arrêté) et ses liens sont `toValidate`.
 * Période de la page : ancienne ou cible seulement si une citation le prouve (`periodEvidence` retrouvée
 * dans la page et contenant un mot de cette période, ou un tel mot dans le titre ou les pages parentes) ;
 * sinon actuelle. Une date ou une année seule ne prouve rien.
 * Période d'un lien : la sienne si elle est celle de la page (vérifiée) ou si sa citation la prouve,
 * sinon celle de la page ; serveur dit arrêté : past, prévu : target. Un lien dit actuel dans une page
 * ancienne est au mieux `toValidate` (sauf `confirmed`).
 * src/dst : identifiant du nœud s'il existe, sinon `type:clé` du nœud à créer.
 */
const { hasEvidence, quoteNames, normalizeText } = require('./evidence');
const { canonicalHost } = require('../resolve/entities');
const { normKey } = require('./schema');
const { serverEnv, normalizeEnv } = require('../lib/environment');
const { nodeKey } = require('../store/repo');
const { isInactiveEdge } = require('../graph/impact');

const CORROBORATION_DAYS = 730;
const DAY = 86400000;
/** Sources de liens issues de la documentation : toute autre source est un inventaire. */
const DOC_SOURCES = new Set(['confluence', 'drawio', 'llm', 'reading', 'manual', 'perimeter']);

/** Types de nœuds qu'une extrémité de lien peut désigner. */
const LINK_END_TYPES = new Set(['server', 'application', 'database', 'url', 'queue', 'path']);

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);

/**
 * Mots qui prouvent une période, sur texte normalisé (minuscules, sans accents) : une page ou un lien
 * n'est ancien ou cible que si sa citation en contient un. Une date ou une année seule ne prouve rien.
 */
const PERIOD_WORDS = {
  past: /(^|[^a-z])(obsoletes?|archivee?s?|archived|anciens?|anciennes?|historiques?|history|historical|perimee?s?|remplacee?s?|replaced|supprimee?s?|removed|arretee?s?|decommission[a-z]*|retiree?s?|retired|demontee?s?|abandonnee?s?|desactivee?s?|terminee?s?|legacy|deprecated|former|pour memoire|plus en service|n'existe plus|n'est plus)($|[^a-z])/,
  target: /(^|[^a-z])(cibles?|target|prevue?s?|planned|futurs?|futures?|a venir|upcoming|projets?|project|planifiee?s?|envisagee?s?|etudes?|prochaine?s?|sera|seront|a creer|a installer|roadmap|feuille de route|to-be|proposee?s?|proposed)($|[^a-z])/,
};
/** La citation contient-elle un mot de la période (ancienne ou cible) ? */
const provesPeriod = (quote, period) => Boolean(PERIOD_WORDS[period] && quote && PERIOD_WORDS[period].test(normalizeText(quote)));

/** Liens qui rattachent une application à une base, une file, un chemin ou une URL. */
const USE_TYPES = new Set(['uses_db', 'reads_from', 'writes_to']);

/**
 * Environnements que nomme une citation : mots (ou deux mots accolés, « pré production ») qui désignent
 * PRD, STG ou DEV (valeurs, synonymes par défaut et bloc « environnements » de mappings.json).
 */
function envsNamed(quote) {
  const words = normalizeText(quote)
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? normalizeEnv(`${words[i]}${words[i + 1]}`) : null;
    if (pair) {
      out.add(pair);
      i++;
      continue;
    }
    const one = normalizeEnv(words[i]);
    if (one) out.add(one);
  }
  return out;
}

function verifyReading(reading, ctx) {
  const { repo, matcher, naemonHosts = new Set(), pageUpdatedAt = null, now = Date.now(), docNodeId = null } = ctx;
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
  // période ancienne ou cible : gardée seulement si une citation de la page (ou le titre) la prouve
  let pagePeriod = page.period === undefined ? 'current' : page.period; // null = illisible
  if (pagePeriod === 'past' || pagePeriod === 'target') {
    const quote = page.periodEvidence;
    const quoted = Boolean(quote) && (hasEvidence(text, quote) || hasEvidence(ctx.headerText || '', quote));
    if (!(quoted && provesPeriod(quote, pagePeriod)) && !provesPeriod(ctx.headerText, pagePeriod)) {
      rejected.push({ what: `période de la page (${pagePeriod})`, reason: quoted || !quote ? 'evidence_mismatch' : 'no_evidence' });
      pagePeriod = 'current';
    }
  }
  const pageReliable = pagePeriod !== null;
  const recent = (at) => {
    const t = Date.parse(at);
    return Number.isFinite(t) && now - t < CORROBORATION_DAYS * DAY;
  };
  const recentPage = pagePeriod === 'current' && pageUpdatedAt && recent(pageUpdatedAt);

  // ---- environnement de la page : retenu seulement si le titre ou les pages parentes l'écrivent ----
  // (jamais déduit des serveurs cités, ni d'une section ou d'une phrase sur quelques serveurs)
  let pageEnv = page.env || null;
  if (pageEnv) {
    const what = `environnement de la page (${pageEnv})`;
    if (!ok(what, page.envEvidence)) pageEnv = null;
    else if (!hasEvidence(ctx.headerText || '', page.envEvidence)) {
      rejected.push({ what, reason: 'not_in_header' });
      pageEnv = null;
    } else if (!envsNamed(page.envEvidence).has(pageEnv)) {
      rejected.push({ what, reason: 'evidence_mismatch' });
      pageEnv = null;
    }
  }

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
  /** Une autre page actuelle, modifiée depuis moins de 24 mois, cite ce serveur comme actif. */
  function citedActiveElsewhere(node) {
    if (!node) return false;
    return repo.edgesTo(node.id).some((e) => {
      const a = e.attrs || {};
      if (e.type !== 'mentions' || e.src === docNodeId || a.retired || a.status !== 'active' || a.period !== 'current') return false;
      const doc = repo.getNode(e.src);
      return Boolean(doc && !isRetired(doc) && doc.attrs && recent(doc.attrs.updatedAt));
    });
  }
  /**
   * Une autre page cite ce serveur comme arrêté : page actuelle, ou plus récente que celle-ci (une page
   * ancienne et plus vieille ne dit rien de l'état d'aujourd'hui). Documents et citations retirés exclus.
   */
  function decommissionedElsewhere(node) {
    if (!node) return false;
    const mine = Date.parse(pageUpdatedAt);
    return repo.edgesTo(node.id).some((e) => {
      const a = e.attrs || {};
      if (e.type !== 'mentions' || e.src === docNodeId || a.retired || a.status !== 'decommissioned') return false;
      const doc = repo.getNode(e.src);
      if (!doc || isRetired(doc)) return false;
      if (a.period === 'current') return true;
      const theirs = Date.parse(doc.attrs && doc.attrs.updatedAt);
      return Number.isFinite(theirs) && Number.isFinite(mine) && theirs > mine;
    });
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
      env: (e && e.env) || (node ? serverEnv(node) : null) || pageEnv || null,
      status: e && e.status !== undefined ? e.status : 'active',
      ip: (e && e.ip) || null,
      inInventory,
      corroborated: false,
      disputed: false,
      evidence: e ? e.evidence : '',
    };
    if (!inInventory) {
      // dit arrêté par une autre page : rien ne le corrobore, ses liens restent à valider
      entry.disputed = decommissionedElsewhere(node);
      entry.corroborated = !entry.disputed && (isSupervised(name, node) || Boolean(recentPage && entry.status === 'active') || citedActiveElsewhere(node));
    }
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

  // liens dont la citation est retrouvée et dont les deux extrémités sont connues
  const found = [];
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
    found.push({ l, from, to });
  }

  // applications qui utilisent une extrémité qui n'est pas une application (base, file, URL...) :
  // liens uses_db actuels de cette page, puis liens actifs du graphe (inventaires ou autres pages)
  /**
   * Période propre d'un lien : gardée si c'est celle de la page (déjà vérifiée), si elle est actuelle,
   * ou si sa citation (ou celle de sa période) la prouve ; sinon le lien prend celle de la page.
   */
  const ownPeriod = (l) => {
    if (!l.period || l.period === 'current' || l.period === pagePeriod) return l.period || null;
    for (const quote of [l.periodEvidence, l.evidence]) {
      if (quote && hasEvidence(text, quote) && provesPeriod(quote, l.period)) return l.period;
    }
    return null;
  };
  const periodOf = (l) => ownPeriod(l) || (pageReliable ? pagePeriod : null);
  const usersInPage = new Map();
  for (const { l, from, to } of found) {
    if (l.type !== 'uses_db' || periodOf(l) !== 'current' || from.kind !== 'application' || to.kind === 'application' || to.kind === 'server') continue;
    if (!usersInPage.has(to.id)) usersInPage.set(to.id, new Set());
    usersInPage.get(to.id).add(from.id);
  }
  function usersOf(end) {
    const out = new Set(usersInPage.get(end.id) || []);
    for (const e of repo.edgesTo(end.id)) {
      if (!USE_TYPES.has(e.type) || isInactiveEdge(e)) continue;
      const src = repo.getNode(e.src);
      if (src && src.type === 'application' && !isRetired(src)) out.add(e.src);
    }
    return [...out];
  }

  const links = [];
  for (const { l, from, to } of found) {
    let trust = 'added';
    // période propre du lien, sinon celle de la page (illisible : actuelle, et le lien est à valider plus bas)
    let period = ownPeriod(l) || (pageReliable ? pagePeriod : 'current');
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
        // serveur d'une autre application de l'inventaire : à valider. Pour une base (file, URL...) :
        // applications qui l'utilisent d'abord (« base de B sur un serveur de B » est juste), puis celles de la page
        const linked = other.kind === 'application' ? [other.id] : [...usersOf(other), ...pageApps];
        if (linked.length && !linked.some((id) => owners.has(id))) trust = 'toValidate';
      } else if (!(entry && (entry.inInventory || entry.corroborated))) {
        trust = 'toValidate'; // serveur hors inventaire que rien ne corrobore
      }
    }
    if (entry && entry.status === 'decommissioned' && period === 'current') period = 'past';
    if (entry && entry.status === 'planned' && period === 'current') period = 'target';
    const unreadable = !pageReliable || (entry && entry.status === null);
    if (unreadable && trust !== 'confirmed' && trust !== 'otherApp') trust = 'toValidate';
    // lien dit actuel dans une page ancienne : la page peut se tromper, seul l'inventaire le confirme
    if (ownPeriod(l) === 'current' && pagePeriod === 'past' && trust === 'added') trust = 'toValidate';
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

  return { kind: page.kind, period: pagePeriod, env: pageEnv, topics: page.topics || [], apps, servers, ips, links, owners, rejected };
}

module.exports = { verifyReading, DOC_SOURCES };
