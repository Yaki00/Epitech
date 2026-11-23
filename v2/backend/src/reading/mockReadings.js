'use strict';
/**
 * Lecture simulée (LLM_MOCK) pour essayer l'analyse Confluence sans IA réelle : chaque page reçoit
 * la lecture préparée pour son titre (fichier JSON { "<titre>": Reading } désigné par
 * LLM_MOCK_READINGS), sinon une lecture vide (page « other », rien de cité).
 * Une valeur texte est renvoyée telle quelle (une chaîne vide simule une réponse vide).
 */
const fs = require('fs');

const EMPTY = { page: { kind: 'other', period: 'current', env: null, topics: [] }, applications: [], entities: [], links: [], owners: [] };

/** Titre de la page lu dans le message de lecture (« Titre : ... »). */
function titleOf(body) {
  const user = ((body && body.messages) || []).find((m) => m.role === 'user');
  const m = String((user && user.content) || '').match(/^Titre : (.*)$/m);
  return m ? m[1].trim() : '';
}

/**
 * @param {string|object} source chemin d'un fichier JSON ou objet { titre: lecture }
 * @returns {(endpoint: string, body: object) => object} mockHandler pour createLlmClient
 */
function createReadingMock(source) {
  let readings = {};
  if (source && typeof source === 'object') readings = source;
  else if (source) readings = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^﻿/, ''));
  return function mockHandler(endpoint, body) {
    const r = Object.prototype.hasOwnProperty.call(readings, titleOf(body)) ? readings[titleOf(body)] : EMPTY;
    const content = typeof r === 'string' ? r : JSON.stringify(r);
    return { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
  };
}

module.exports = { createReadingMock, titleOf };
