'use strict';
/**
 * Écriture des fiches vérifiées dans le graphe, et liens entre fiches.
 *
 *  - applyFiches : une page => des nœuds `fiche:<pageId>-<n>` (type `fiche`) et leurs liens `concerne`
 *    (fiche vers application ou serveur) et `vient_de` (fiche vers document), source `knowledge`.
 *    Une relecture purge les liens `knowledge` de la page et marque `retired` les nœuds en trop (le
 *    store ne supprime jamais un nœud).
 *  - linkFiches : en fin de passage, relie un correctif à l'incident qu'il corrige (lien `corrige`) et
 *    marque la procédure remplacée (`replacedBy`).
 * Les liens de fiche ne propagent jamais une panne (voir NON_PROPAGATING dans graph/impact.js).
 */
const { normalizeText } = require('../reading/evidence');

const SOURCE = 'knowledge';
/** Source de référence des liens écrits par linkFiches (tous purgés puis refaits à chaque appel). */
const LINK_REF = 'fiches';
const CONFIDENCE = 0.9;

const ficheId = (pageId, n) => `fiche:${pageId}-${n}`;

/** Mots normalisés (sans accent ni ponctuation) d'un texte, recollés par des espaces. */
function words(s) {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Adresse de la fiche : celle de la page, avec l'ancre de sa section quand la page en donne une. */
function ficheUrl(page, section) {
  const url = (page && page.url) || '';
  if (!url || !section) return url;
  const want = words(section);
  const hit = ((page && page.sections) || []).find((s) => s.anchor && words(s.heading) === want);
  return hit ? `${url.split('#')[0]}#${hit.anchor}` : url;
}

/**
 * @param {object} repo
 * @param {{fiches: object[]}|object[]} verified  résultat de verifyFiches (ou sa liste de fiches)
 * @param {{pageId, docNodeId, page: {title, url, updatedAt, sections?}, period}} ctx
 * @returns {{fiches: string[]}} identifiants des fiches écrites
 */
function applyFiches(repo, verified, { pageId, docNodeId, page = {}, period }) {
  const list = Array.isArray(verified) ? verified : (verified && verified.fiches) || [];
  const pid = String(pageId);

  // purge de ce que la page avait produit (les liens des autres sources ne sont jamais touchés)
  repo.removeEdgesBySourceRef(pid, { sources: [SOURCE] });

  const ids = [];
  list.forEach((f, i) => {
    const id = repo.upsertNode({
      type: 'fiche',
      key: `${pid}-${i + 1}`,
      name: f.title.text,
      source: 'llm',
      attrs: {
        kind: f.kind,
        title: f.title.text,
        section: f.section || null,
        url: ficheUrl(page, f.section),
        pageId: pid,
        docId: docNodeId,
        period: period === undefined ? null : period,
        updatedAt: page.updatedAt || null,
        date: f.date ? f.date.text : null,
        fields: f.fields,
        lists: f.lists,
        tickets: f.tickets,
        keywords: f.keywords,
        unresolved: f.unresolved,
        replaces: f.replaces || null,
        fixes: f.fixes || null,
        replacedBy: null,
        replacedByEvidence: null,
      },
    });
    repo.patchNodeAttrs(id, { retired: undefined, retiredAt: undefined });
    for (const target of [...f.appIds, ...f.serverIds]) {
      if (repo.getNode(target)) repo.addEdge({ src: id, dst: target, type: 'concerne', source: SOURCE, sourceRef: pid, confidence: CONFIDENCE });
    }
    repo.addEdge({ src: id, dst: docNodeId, type: 'vient_de', source: SOURCE, sourceRef: pid, confidence: CONFIDENCE });
    ids.push(id);
  });

  // fiches en trop d'une lecture précédente : retirées (leurs liens viennent d'être purgés)
  const at = new Date().toISOString();
  for (const n of repo.listByType('fiche')) {
    if (n.attrs.pageId === pid && !ids.includes(n.id) && !n.attrs.retired) repo.patchNodeAttrs(n.id, { retired: true, retiredAt: at });
  }
  return { fiches: ids };
}

/** Nombre de fiches (non retirées) écrites pour une page. */
function ficheCountOf(repo, pageId) {
  return repo.listByType('fiche').filter((n) => String(n.attrs.pageId) === String(pageId) && !n.attrs.retired).length;
}

const ticketKeys = (f) => new Set((f.attrs.tickets || []).map((t) => words(t).replace(/ /g, '')).filter(Boolean));

/** L'incident est nommé par le texte `fixes` : mêmes mots, ou titre (2 mots ou plus) contenu en mots entiers. */
function namesTitle(text, title) {
  const a = words(text);
  const b = words(title);
  if (!a || !b) return false;
  return a === b || (b.split(' ').length >= 2 && ` ${a} `.includes(` ${b} `));
}

/** Adresses citées dans un texte, sans ancre ni ponctuation finale. */
function urlsIn(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '').split('#')[0]);
}

/** Ancienne procédure désignée par `replaces` : lien Confluence cité d'abord, puis même application et même but. */
function findReplaced(newer, procedures, appsOf) {
  const item = newer.attrs.replaces;
  const others = procedures.filter((o) => o.id !== newer.id && o.attrs.pageId !== newer.attrs.pageId);
  const cited = urlsIn(`${item.text} ${item.evidence}`);
  if (cited.length) {
    const byUrl = others.filter((o) => {
      const u = String(o.attrs.url || '').split('#')[0];
      return u && cited.some((c) => c === u || c.endsWith(`/${o.attrs.pageId}`) || c.includes(`pageId=${o.attrs.pageId}`));
    });
    if (byUrl.length) return byUrl.find((o) => namesTitle(item.text, o.attrs.title)) || byUrl[0];
  }
  const myApps = appsOf(newer);
  return (
    others.find((o) => {
      if (!appsOf(o).some((a) => myApps.includes(a))) return false;
      const goal = o.attrs.fields && o.attrs.fields.goal ? o.attrs.fields.goal.text : '';
      return [o.attrs.title, goal].some((t) => t && (words(t) === words(item.text) || namesTitle(item.text, t)));
    }) || null
  );
}

/**
 * Liens entre fiches, refaits en entier à chaque appel (fin de passage) :
 *  - `corrige` : correctif vers incident, quand ils partagent un ticket ou que `fixes` nomme le titre de l'incident ;
 *  - `replacedBy` (id de la procédure plus récente) et `replacedByEvidence` (la citation) sur la procédure remplacée.
 * @returns {{corrige: number, remplacees: number}}
 */
function linkFiches(repo) {
  repo.removeEdgesBySourceRef(LINK_REF, { sources: [SOURCE] });
  const all = repo.listByType('fiche');
  for (const n of all) if (n.attrs.replacedBy) repo.patchNodeAttrs(n.id, { replacedBy: null, replacedByEvidence: null });
  const live = all.filter((n) => !n.attrs.retired);

  const incidents = live.filter((n) => n.attrs.kind === 'incident');
  let corrige = 0;
  for (const c of live.filter((n) => n.attrs.kind === 'correctif')) {
    const mine = ticketKeys(c);
    const hit = new Set();
    for (const i of incidents) {
      const shared = [...ticketKeys(i)].some((t) => mine.has(t));
      if (shared || (c.attrs.fixes && namesTitle(c.attrs.fixes.text, i.attrs.title))) hit.add(i.id);
    }
    for (const id of hit) {
      repo.addEdge({ src: c.id, dst: id, type: 'corrige', source: SOURCE, sourceRef: LINK_REF, confidence: CONFIDENCE });
      corrige++;
    }
  }

  const procedures = live.filter((n) => n.attrs.kind === 'procedure');
  const appsOf = (n) => repo.edgesFrom(n.id).filter((e) => e.type === 'concerne' && e.dst.startsWith('application:')).map((e) => e.dst);
  let remplacees = 0;
  const stamp = (n) => String(n.attrs.updatedAt || '');
  for (const newer of procedures.filter((n) => n.attrs.replaces)) {
    const old = findReplaced(newer, procedures, appsOf);
    if (!old) continue;
    const cur = repo.getNode(old.id);
    if (cur.attrs.replacedBy) {
      const other = repo.getNode(cur.attrs.replacedBy);
      if (other && stamp(other) >= stamp(newer)) continue; // la plus récente l'emporte
    } else remplacees++;
    repo.patchNodeAttrs(old.id, { replacedBy: newer.id, replacedByEvidence: newer.attrs.replaces.evidence });
  }
  return { corrige, remplacees };
}

module.exports = { applyFiches, linkFiches, ficheCountOf, ficheUrl, ficheId };
