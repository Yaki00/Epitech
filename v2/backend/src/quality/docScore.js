'use strict';
/**
 * Score de documentation d'une application, sur 100, calculé à la volée (rien n'est stocké).
 *  - architecture (35) : au moins une page d'architecture liée à l'application
 *  - architectureClean (25) : aucune page d'architecture avec un écart (audit non ok) ; 0 sans page
 *  - serversDocumented (30) : part des serveurs de l'application cités par une page liée
 *  - summary (10) : résumé disponible
 * Les nœuds et liens retirés (attrs.retired) sont ignorés.
 */

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function docScore(repo, appId) {
  const app = repo.getNode(appId);
  const out = app ? repo.edgesFrom(app.id).filter((e) => !isRetired(e)) : [];

  // serveurs actuels de l'application
  const servers = new Map();
  for (const e of out.filter((x) => x.type === 'runs_on')) {
    const n = repo.getNode(e.dst);
    if (n && n.type === 'server' && !isRetired(n)) servers.set(n.id, n);
  }

  // pages liées (documented_in) non retirées, avec le contrôle d'architecture porté par le lien
  const pages = [];
  for (const e of out.filter((x) => x.type === 'documented_in')) {
    const doc = repo.getNode(e.dst);
    if (doc && !isRetired(doc)) pages.push({ doc, audit: (e.attrs && e.attrs.audit) || null });
  }
  const archi = pages.filter((p) => p.doc.attrs.pageKind === 'architecture');
  const withGap = archi.filter((p) => p.audit && p.audit.ok === false);

  // serveurs cités : liens "mentions" des pages, ou noms confirmés par le contrôle d'une page
  const cited = new Set();
  const confirmed = new Set();
  for (const p of pages) {
    for (const e of repo.edgesFrom(p.doc.id).filter((x) => x.type === 'mentions' && !isRetired(x))) cited.add(e.dst);
    for (const name of (p.audit && p.audit.confirmed) || []) confirmed.add(String(name).toLowerCase());
  }
  const citedCount = [...servers.values()].filter((s) => cited.has(s.id) || confirmed.has(String(s.name).toLowerCase())).length;

  const parts = [];
  parts.push({
    key: 'architecture',
    points: archi.length ? 35 : 0,
    max: 35,
    detail: archi.length ? plural(archi.length, "page d'architecture", "pages d'architecture") : "aucune page d'architecture",
  });
  parts.push({
    key: 'architectureClean',
    points: archi.length && !withGap.length ? 25 : 0,
    max: 25,
    detail: !archi.length
      ? "pas de page d'architecture à contrôler"
      : withGap.length
        ? `${withGap.length} page(s) sur ${archi.length} en écart avec les inventaires`
        : 'cohérente avec les inventaires',
  });
  parts.push({
    key: 'serversDocumented',
    points: servers.size ? Math.round((30 * citedCount) / servers.size) : 0,
    max: 30,
    detail: servers.size ? `${plural(citedCount, 'serveur cité', 'serveurs cités')} sur ${servers.size}` : 'aucun serveur connu pour cette application',
  });
  const hasSummary = Boolean(app && app.attrs.summary);
  parts.push({ key: 'summary', points: hasSummary ? 10 : 0, max: 10, detail: hasSummary ? 'résumé disponible' : 'aucun résumé' });

  return { score: parts.reduce((s, p) => s + p.points, 0), parts };
}

module.exports = { docScore };
