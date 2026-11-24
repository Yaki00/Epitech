'use strict';
/**
 * Reclassement facultatif des premières fiches par un modèle de la passerelle (éteint par défaut).
 * La recherche par mots-clés reste la référence : au moindre échec, son ordre est gardé.
 */
const { searchKnowledge } = require('./search');

const RERANK_TOP = 20; // nombre de fiches soumises au modèle
const DEFAULT_LIMIT = 10; // mêmes valeurs que searchKnowledge
const MAX_LIMIT = 50;

/** Texte soumis au modèle pour une fiche. */
const ficheText = (f) => [f.title, f.section, f.excerpt].filter(Boolean).join('. ');

/**
 * Enveloppe asynchrone de searchKnowledge : même résultat, avec `rerank` (async (query, texts) => scores) les
 * RERANK_TOP premières fiches sont réordonnées par score décroissant (stable), le reste ne bouge pas.
 */
async function searchWithRerank(index, repo, matcher, opts = {}) {
  const { rerank, ...rest } = opts;
  if (typeof rerank !== 'function') return searchKnowledge(index, repo, matcher, rest);
  // le modèle voit les vingt premiers résultats par mots-clés, même si l'appelant en demande moins
  const wanted = Math.min(Math.max(Number(rest.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const out = searchKnowledge(index, repo, matcher, { ...rest, limit: Math.max(wanted, RERANK_TOP) });
  if (out.fiches.length < 2) return { ...out, fiches: out.fiches.slice(0, wanted) };
  const cut = (o) => ({ ...o, fiches: o.fiches.slice(0, wanted) });
  const head = out.fiches.slice(0, RERANK_TOP);
  let scores;
  try {
    scores = await rerank(String(rest.query || ''), head.map(ficheText));
  } catch {
    return cut(out);
  }
  if (!Array.isArray(scores) || scores.length !== head.length || scores.some((s) => !Number.isFinite(s))) return cut(out);
  const order = head.map((f, i) => ({ f, i, s: scores[i] })).sort((a, b) => b.s - a.s || a.i - b.i);
  return cut({ ...out, fiches: [...order.map((x) => x.f), ...out.fiches.slice(RERANK_TOP)] });
}

/**
 * Fonction `rerank` pour searchWithRerank, branchée sur llm.rerank. Un échec est signalé une seule fois
 * (par fonction créée, donc une fois par processus) puis renvoie null : l'ordre des mots-clés est gardé.
 */
function createReranker({ llm, logger, path }) {
  let warned = false;
  return async (query, texts) => {
    try {
      return await llm.rerank({ query, documents: texts, path });
    } catch (err) {
      if (!warned) {
        warned = true;
        if (logger && logger.warn) logger.warn(`reclassement des fiches indisponible (rerank), ordre des mots-clés gardé : ${err.message}`);
      }
      return null;
    }
  };
}

/** Contrôle du doctor : [niveau, message]. N'appelle la passerelle que si KNOWLEDGE_RERANK est actif. */
async function doctorRerank(config, llm) {
  if (!config.knowledge || !config.knowledge.rerank) return ['INFO', 'reclassement des fiches éteint (KNOWLEDGE_RERANK=false)'];
  const t0 = Date.now();
  try {
    const scores = await llm.rerank({ query: 'test', documents: ['premier document', 'second document'], path: config.knowledge.rerankPath });
    if (!Array.isArray(scores) || scores.length !== 2) throw new Error('réponse inattendue');
    return ['OK', `reclassement des fiches OK (${Date.now() - t0} ms)`];
  } catch (err) {
    return ['WARN', `reclassement des fiches : ${err.message} (KNOWLEDGE_RERANK=true, chemin ${config.knowledge.rerankPath})`];
  }
}

module.exports = { searchWithRerank, createReranker, doctorRerank, RERANK_TOP };
