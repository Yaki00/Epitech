'use strict';
/**
 * Écriture dans le graphe d'une lecture vérifiée (type Verified, voir verify.js).
 *
 * La page est d'abord purgée de tout ce que ses analyses précédentes avaient écrit (sources
 * documentaires seulement : les liens des inventaires ne sont jamais touchés), puis recréée à
 * partir de la lecture. Les liens d'une autre application (`otherApp`) ne deviennent jamais des
 * liens du graphe : ils nourrissent le contrôle d'architecture.
 */
const { nodeKey } = require('../store/repo');
const { auditArchitecturePage } = require('../perimeter/architecture');

/** Sources de liens écrites par l'analyse d'une page (purgées à chaque relecture). */
const PAGE_SOURCES = ['confluence', 'llm', 'drawio'];
const INACTIVE_STATUS = new Set(['decommissioned', 'planned']);
const CONFIDENCE = { documented: { subject: 0.9, cited: 0.6 }, mention: 0.9, added: 0.8, toValidate: 0.5, owner: 0.8 };

function applyReading(repo, verified, { pageId, docNodeId, page = {}, matcher = null, now = Date.now() }) {
  const out = { mentions: 0, links: 0, owners: 0, toValidate: 0, otherApp: 0, rejected: (verified.rejected || []).length };

  // 1. purge de ce que la page avait produit
  repo.removeEdgesBySourceRef(pageId, { sources: PAGE_SOURCES });

  // 2. le document
  const isArchi = verified.kind === 'architecture';
  repo.patchNodeAttrs(docNodeId, {
    pageKind: isArchi ? 'architecture' : undefined,
    pageKindAi: verified.kind,
    period: verified.period,
    env: verified.env,
  });

  // serveurs cités : ceux qui sont hors inventaire sont créés (marqués comme venant de la lecture)
  const serverIds = new Map(); // entrée -> id du nœud
  for (const s of verified.servers || []) {
    let id = s.nodeId;
    if (!id) {
      id = repo.upsertNode({
        type: 'server',
        key: s.name,
        name: s.name,
        source: 'llm',
        attrs: { fromLlm: true, outOfInventory: true, ...(s.env ? { environment: s.env } : {}) },
      });
    }
    serverIds.set(s, id);
  }

  // 3. mentions du document, avec le statut du serveur et la période de la page : un serveur créé par
  // une lecture et seulement cité comme ancien, arrêté ou prévu n'est pas gardé actif (voir retireOrphans)
  const mentionStatus = new Map(); // id -> statut retenu (un statut actif ou inconnu l'emporte sur arrêté ou prévu)
  for (const [s, id] of serverIds) {
    const prev = mentionStatus.get(id);
    if (prev === undefined || INACTIVE_STATUS.has(prev)) mentionStatus.set(id, s.status === undefined ? 'active' : s.status);
  }
  for (const [id, status] of mentionStatus) {
    repo.addEdge({ src: docNodeId, dst: id, type: 'mentions', source: 'confluence', sourceRef: pageId, confidence: CONFIDENCE.mention, attrs: { status, period: verified.period === undefined ? 'current' : verified.period } });
    out.mentions++;
  }

  // 4. documented_in : un lien par application, avec son rôle (sujet ou citée)
  for (const a of verified.apps || []) {
    const attrs = { role: a.role, written: a.written, evidence: a.evidence };
    if (isArchi && a.role === 'subject' && matcher && matcher.apps.some((x) => x.id === a.appId)) {
      const ips = (verified.ips || []).map((x) => ({ nodeId: null, name: x.ip, ip: null, inInventory: false, status: x.status }));
      attrs.audit = auditArchitecturePage(repo, matcher, page, a.appId, { now, cited: [...(verified.servers || []), ...ips], env: verified.env, topics: verified.topics });
    }
    repo.addEdge({ src: a.appId, dst: docNodeId, type: 'documented_in', source: 'confluence', sourceRef: pageId, confidence: CONFIDENCE.documented[a.role] || CONFIDENCE.documented.cited, attrs });
  }

  // 5. liens lus dans la page
  const ensureNode = (id, name) => {
    if (repo.getNode(id)) return;
    const i = id.indexOf(':');
    const type = id.slice(0, i);
    const key = id.slice(i + 1);
    const attrs = type === 'server' ? { fromLlm: true, outOfInventory: true } : { fromLlm: true };
    repo.upsertNode({ type, key, name: name || key, source: 'llm', attrs });
  };
  for (const l of verified.links || []) {
    if (l.trust === 'otherApp') {
      out.otherApp++;
      continue;
    }
    if (l.trust === 'confirmed') continue; // déjà dans l'inventaire : rien de nouveau
    ensureNode(l.src, l.srcName);
    ensureNode(l.dst, l.dstName);
    repo.addEdge({
      src: l.src,
      dst: l.dst,
      type: l.type,
      source: 'llm',
      sourceRef: pageId,
      confidence: l.trust === 'toValidate' ? CONFIDENCE.toValidate : CONFIDENCE.added,
      attrs: { trust: l.trust, period: l.period, evidence: l.evidence, docId: docNodeId },
    });
    out.links++;
    if (l.trust === 'toValidate') out.toValidate++;
  }

  // 6. responsables
  for (const o of verified.owners || []) {
    const id = repo.upsertNode({ type: o.kind, key: nodeKey(o.kind, o.name), name: o.name, source: 'llm', attrs: { fromLlm: true } });
    repo.addEdge({
      src: o.appId,
      dst: id,
      type: 'owned_by',
      source: 'llm',
      sourceRef: pageId,
      confidence: CONFIDENCE.owner,
      attrs: { role: o.role, period: o.period, evidence: o.evidence, docId: docNodeId },
    });
    out.owners++;
  }
  return out;
}

module.exports = { applyReading, PAGE_SOURCES, INACTIVE_STATUS };
