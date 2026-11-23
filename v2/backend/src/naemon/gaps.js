'use strict';
/**
 * Écarts entre l'inventaire, Confluence et Naemon, limités au périmètre (serveurs retirés exclus).
 */
const { serverEnv } = require('../lib/environment');
const { writeCsvReport } = require('../lib/report');
const { isInactiveEdge } = require('../graph/impact');

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);
/** Serveur créé par une lecture et retiré depuis (plus cité que comme ancien, arrêté ou prévu). */
const isFormer = (repo, name) => repo.resolve(name).some((n) => n.type === 'server' && n.attrs.fromLlm && isRetired(n));

/**
 * @returns {{notMonitored: object[], unknownMonitored: string[], citedNotInInventory: string[]}}
 *  notMonitored : serveurs des applications du périmètre sans hôte Naemon
 *  unknownMonitored : hôtes Naemon d'un hostgroup du périmètre, inconnus des inventaires
 *  citedNotInInventory : serveurs cités par les pages d'architecture actuelles, absents des inventaires
 *    (ni ceux que la page dit arrêtés ou prévus, ni ceux des pages anciennes ou cibles, ni les retirés)
 *  toValidate : liens lus par l'IA et à valider ({ target, application, page, type })
 */
function computeGaps(repo, status) {
  const apps = repo.listByType('application').filter((a) => a.attrs && a.attrs.perimeter && !isRetired(a));
  const notMonitored = [];
  const seen = new Set();
  const cited = new Map();
  const toValidate = [];
  const seenValidate = new Set();
  for (const app of apps) {
    for (const e of repo.edgesFrom(app.id)) {
      if (isRetired(e)) continue;
      if (e.attrs && e.attrs.trust === 'toValidate' && !seenValidate.has(`${app.id}|${e.dst}|${e.type}`)) {
        const dst = repo.getNode(e.dst);
        if (dst && !isRetired(dst) && e.attrs.period !== 'past') {
          seenValidate.add(`${app.id}|${e.dst}|${e.type}`);
          toValidate.push({ target: dst, application: app, page: (e.attrs.docId && repo.getNode(e.attrs.docId)) || null, type: e.type });
        }
      }
      if (isInactiveEdge(e)) continue; // ancien, cible, à valider : jamais compté comme supervisable
      if (e.type === 'runs_on' && !seen.has(e.dst)) {
        seen.add(e.dst);
        const srv = repo.getNode(e.dst);
        const st = status && status.servers && status.servers[e.dst];
        if (srv && srv.type === 'server' && !isRetired(srv) && st && st.state === 'not_monitored') notMonitored.push(srv);
      } else if (e.type === 'documented_in' && e.attrs && e.attrs.audit) {
        // page ancienne ou cible : ses serveurs inconnus ne sont pas des écarts actuels
        const doc = repo.getNode(e.dst);
        const period = doc && doc.attrs ? doc.attrs.period : null;
        if (period === 'past' || period === 'target') continue;
        for (const h of e.attrs.audit.unknown || []) {
          const k = String(h).toLowerCase();
          if (cited.has(k) || isFormer(repo, h)) continue;
          cited.set(k, String(h));
        }
      }
    }
  }
  const byName = (a, b) => a.localeCompare(b);
  return {
    notMonitored: notMonitored.sort((a, b) => byName(a.name, b.name)),
    unknownMonitored: [...new Set((status && status.unmatchedHosts) || [])].sort(byName),
    citedNotInInventory: [...cited.values()].sort(byName),
    toValidate: toValidate.sort((a, b) => byName(a.target.name, b.target.name) || byName(a.application.name, b.application.name)),
  };
}

/** Écrit ecarts-naemon.csv (une ligne par écart) et renvoie son chemin. */
function writeGapsReport(dir, gaps) {
  const rows = [
    ...gaps.notMonitored.map((s) => ['serveur sans supervision', s.name, (s.attrs && s.attrs.ip) || '', serverEnv(s) || '']),
    ...gaps.unknownMonitored.map((h) => ['hôte supervisé inconnu des inventaires', h, '', '']),
    ...gaps.citedNotInInventory.map((h) => ['serveur cité dans Confluence, absent des inventaires', h, '', '']),
    ...(gaps.toValidate || []).map((l) => [`lien à valider (${l.application.name})`, l.target.name, (l.target.attrs && l.target.attrs.ip) || '', (l.target.type === 'server' && serverEnv(l.target)) || '']),
  ];
  return writeCsvReport(dir, 'ecarts-naemon', ['écart', 'serveur ou hôte', 'IP', 'environnement'], rows);
}

module.exports = { computeGaps, writeGapsReport };
