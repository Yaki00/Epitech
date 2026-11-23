'use strict';
/**
 * Résumé IA d'une application : rédigé à partir de ses pages Confluence et des faits sûrs de l'inventaire.
 *
 * - Pages : celles rattachées à l'application (lien documented_in), pages d'architecture d'abord,
 *   puis les plus pertinentes et les plus récentes, jusqu'à un budget de texte.
 *   Leur texte vient de attrs.excerpt, gardé par la synchro Confluence pour les pages du périmètre.
 * - Faits : serveurs, environnements, OS, bases, échanges avec les autres applications (graphe).
 * - Le résumé n'est refait que si ces entrées changent (empreinte summaryHash).
 */
const { stableHash, sha256 } = require('../lib/hash');

const SYSTEM = `Tu rédiges la description d'une application d'entreprise pour une fiche d'inventaire,
à partir d'extraits de sa documentation interne (Confluence) et de faits d'inventaire.
Écris en français, en un paragraphe de 4 à 8 phrases, sur un ton factuel et sans formule d'introduction.
Décris, seulement si c'est écrit : son rôle métier, les processus ou utilisateurs servis, son architecture
(serveurs, environnements, bases), ses échanges avec d'autres applications, et les points d'attention
(redondance, sauvegarde, supervision, éléments obsolètes).
Règles :
- N'invente rien. Une information absente des extraits et des faits n'apparaît pas.
- Les faits d'inventaire sont sûrs. Le texte des pages peut être ancien : une information qui ne vient
  que d'une page de plus de 2 ans est signalée ("d'après une page de 2021").
- Si deux sources se contredisent, dis-le en une phrase.
Rédige le paragraphe en français, puis sa traduction fidèle en anglais (mêmes informations, rien de plus).
Réponds en JSON strict, sans texte autour : {"summary": "<français>", "summary_en": "<English>"}`;

// à incrémenter quand la forme du résumé change : tous les résumés sont refaits au passage suivant
const SUMMARY_VERSION = 2;

const EXCERPT_MAX = 3000;

/** Faits sûrs tirés du graphe pour une application. */
function applicationFacts(repo, app) {
  const out = repo.edgesFrom(app.id);
  const nodes = (type) => [...new Set(out.filter((e) => e.type === type).map((e) => e.dst))].map((id) => repo.getNode(id)).filter(Boolean);
  const servers = nodes('runs_on');
  const count = (vals) => Object.entries(vals.filter(Boolean).reduce((acc, v) => ((acc[v] = (acc[v] || 0) + 1), acc), {})).map(([k, n]) => `${k} (${n})`);
  const calledBy = [...new Set(repo.edgesTo(app.id).filter((e) => ['calls', 'reads_from', 'depends_on'].includes(e.type)).map((e) => e.src))]
    .map((id) => repo.getNode(id)?.name)
    .filter(Boolean)
    .sort();
  return {
    application: app.name,
    auid: app.attrs.auid || null,
    profil: app.attrs.profile || null,
    confidentialite: app.attrs.confidentiality || null,
    serveurs: servers.length,
    environnements: count(servers.map((s) => String(s.attrs.environment || '').toUpperCase())),
    os: count(servers.map((s) => [s.attrs.os, s.attrs.osVersion].filter(Boolean).join(' '))),
    bases: nodes('uses_db').map((n) => n.name).sort(),
    appelle: nodes('calls').map((n) => n.name).sort(),
    depend_de: [...nodes('depends_on'), ...nodes('reads_from')].map((n) => n.name).sort(),
    utilisee_par: calledBy,
  };
}

/**
 * Pages et faits qui serviront au résumé, avec leur empreinte.
 * @returns {{docs: Array<{id, title, updatedAt, architecture, excerpt}>, facts: object, hash: string}}
 */
function summaryInputs(repo, app, { maxChars = 14000 } = {}) {
  const best = new Map();
  for (const e of repo.edgesFrom(app.id).filter((x) => x.type === 'documented_in')) {
    const prev = best.get(e.dst);
    if (!prev || e.confidence > prev) best.set(e.dst, e.confidence);
  }
  const candidates = [...best.entries()]
    .map(([id, confidence]) => ({ node: repo.getNode(id), confidence }))
    .filter((x) => x.node && x.node.attrs.excerpt)
    .sort(
      (a, b) =>
        Number(b.node.attrs.pageKind === 'architecture') - Number(a.node.attrs.pageKind === 'architecture') ||
        b.confidence - a.confidence ||
        String(b.node.attrs.updatedAt || '').localeCompare(String(a.node.attrs.updatedAt || ''))
    );
  const docs = [];
  let used = 0;
  for (const { node } of candidates) {
    if (used >= maxChars) break;
    const excerpt = String(node.attrs.excerpt).slice(0, Math.min(EXCERPT_MAX, maxChars - used));
    used += excerpt.length;
    docs.push({ id: node.id, title: node.name, updatedAt: node.attrs.updatedAt || null, architecture: node.attrs.pageKind === 'architecture', excerpt });
  }
  const facts = applicationFacts(repo, app);
  const hash = stableHash({ v: SUMMARY_VERSION, docs: docs.map((d) => [d.id, sha256(d.excerpt)]), facts }).slice(0, 16);
  return { docs, facts, hash };
}

function buildMessages(app, inputs) {
  const pages = inputs.docs
    .map((d, i) => `### Page ${i + 1} : ${d.title}${d.architecture ? ' (architecture)' : ''}${d.updatedAt ? `, modifiée le ${String(d.updatedAt).slice(0, 10)}` : ''}\n${d.excerpt}`)
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Application : ${app.name}\n\nFaits d'inventaire (sûrs) :\n${JSON.stringify(inputs.facts, null, 1)}\n\nExtraits de documentation :\n${pages}` },
  ];
}

/**
 * Demande le résumé à l'IA (modèle LLM_MODEL_SUMMARY), en français et en anglais en un seul appel.
 * @returns {Promise<{fr: string, en: string|null}>}
 */
async function summarizeApplication(llm, app, inputs) {
  const raw = await llm.chatJson({ task: 'summary', messages: buildMessages(app, inputs), temperature: 0.2, maxTokens: 1600, schema: { summary: 'string' } });
  const fr = String(raw.summary || '').trim();
  if (fr.length < 20) throw new Error('résumé vide ou trop court');
  const en = String(raw.summary_en || '').trim();
  return { fr, en: en.length >= 20 ? en : null };
}

/** Enregistre le résumé (français et anglais) et ses sources sur l'application. */
function saveSummary(repo, app, { fr, en }, inputs, now = new Date()) {
  repo.upsertNode({
    type: 'application',
    key: app.id.slice('application:'.length),
    name: app.name,
    source: 'llm',
    attrs: {
      summary: fr,
      summaryEn: en,
      summaryAt: now.toISOString(),
      summaryHash: inputs.hash,
      summarySources: inputs.docs.map((d) => ({ id: d.id, title: d.title })),
    },
  });
}

module.exports = { summaryInputs, summarizeApplication, saveSummary, applicationFacts, buildMessages, SYSTEM };
