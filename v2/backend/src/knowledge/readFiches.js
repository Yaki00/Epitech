'use strict';
/**
 * Lecture IA des fiches d'une page d'exploitation : un appel par morceau (même découpage que la
 * lecture de la page), puis fusion. Une erreur du modèle remonte telle quelle : c'est l'appelant
 * qui décide qu'une fiche en échec ne fait pas échouer la page.
 */
const { chunkPage } = require('../reading/readPage');
const { buildFicheMessages } = require('./prompt');
const { sanitizeFiches, mergeFicheReadings, FICHES_SCHEMA } = require('./schema');

/**
 * @param {object} llm   client créé par createLlmClient
 * @param {object} input { title, ancestors, today, kind, sections?|text, apps, consignes }
 * @param {object} [opts] { chunkChars = 12000, maxTokens }
 * @returns {Promise<{fiches: object[]}>}
 */
async function readFiches(llm, input, { chunkChars = 12000, maxTokens = 4096 } = {}) {
  // Le texte seul compte : les schémas ne portent pas de fiche.
  const chunks = chunkPage({ ...input, diagramsText: '' }, chunkChars);
  if (!chunks.length) return { fiches: [] };
  const readings = [];
  for (let i = 0; i < chunks.length; i++) {
    const messages = buildFicheMessages({
      title: input.title,
      ancestors: input.ancestors,
      today: input.today,
      kind: input.kind,
      text: chunks[i].text,
      apps: input.apps,
      consignes: input.consignes,
      part: { index: i + 1, count: chunks.length },
    });
    const raw = await llm.chatJson({ task: 'extract', messages, temperature: 0, maxTokens, schema: FICHES_SCHEMA });
    readings.push(sanitizeFiches(raw));
  }
  return mergeFicheReadings(readings);
}

module.exports = { readFiches };
