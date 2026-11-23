'use strict';
/**
 * Écarts entre l'inventaire, Confluence et Naemon, limités au périmètre (serveurs retirés exclus).
 */
const { writeCsvReport } = require('../lib/report');

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);

/**
 * @returns {{notMonitored: object[], unknownMonitored: string[], citedNotInInventory: string[]}}
 *  notMonitored : serveurs des applications du périmètre sans hôte Naemon
 *  unknownMonitored : hôtes Naemon d'un hostgroup du périmètre, inconnus des inventaires
 *  citedNotInInventory : serveurs cités par les pages d'architecture, absents des inventaires
 */
function computeGaps(repo, status) {
  const apps = repo.listByType('application').filter((a) => a.attrs && a.attrs.perimeter && !isRetired(a));
  const notMonitored = [];
  const seen = new Set();
  const cited = new Map();
  for (const app of apps) {
    for (const e of repo.edgesFrom(app.id)) {
      if (isRetired(e)) continue;
      if (e.type === 'runs_on' && !seen.has(e.dst)) {
        seen.add(e.dst);
        const srv = repo.getNode(e.dst);
        const st = status && status.servers && status.servers[e.dst];
        if (srv && srv.type === 'server' && !isRetired(srv) && st && st.state === 'not_monitored') notMonitored.push(srv);
      } else if (e.type === 'documented_in' && e.attrs && e.attrs.audit) {
        for (const h of e.attrs.audit.unknown || []) if (!cited.has(String(h).toLowerCase())) cited.set(String(h).toLowerCase(), String(h));
      }
    }
  }
  const byName = (a, b) => a.localeCompare(b);
  return {
    notMonitored: notMonitored.sort((a, b) => byName(a.name, b.name)),
    unknownMonitored: [...new Set((status && status.unmatchedHosts) || [])].sort(byName),
    citedNotInInventory: [...cited.values()].sort(byName),
  };
}

/** Écrit ecarts-naemon.csv (une ligne par écart) et renvoie son chemin. */
function writeGapsReport(dir, gaps) {
  const rows = [
    ...gaps.notMonitored.map((s) => ['serveur sans supervision', s.name, (s.attrs && s.attrs.ip) || '', (s.attrs && s.attrs.environment) || '']),
    ...gaps.unknownMonitored.map((h) => ['hôte supervisé inconnu des inventaires', h, '', '']),
    ...gaps.citedNotInInventory.map((h) => ['serveur cité dans Confluence, absent des inventaires', h, '', '']),
  ];
  return writeCsvReport(dir, 'ecarts-naemon', ['écart', 'serveur ou hôte', 'IP', 'environnement'], rows);
}

module.exports = { computeGaps, writeGapsReport };
