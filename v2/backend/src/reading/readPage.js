'use strict';
/**
 * Lecture IA d'une page : un appel, ou un par morceau si la page est longue.
 *  - découpe aux limites des sections (une section n'est coupée que si elle dépasse à elle
 *    seule la taille d'un morceau, et alors entre deux paragraphes) ;
 *  - chaque morceau reçoit le titre, les pages parentes, le périmètre, les consignes et, à partir
 *    du deuxième, les applications déjà reconnues ;
 *  - les lectures des morceaux sont nettoyées puis fusionnées (règles dans schema.js) ;
 *  - un morceau en échec fait échouer toute la page : l'appelant garde la lecture précédente.
 */
const { buildReadingMessages, READING_VERSION } = require('./prompt');
const { sanitizeReading, mergeReadings, READING_SCHEMA } = require('./schema');

const SEP = '\n\n';

/** Sections de la page : `sections` du parseur si présentes, sinon blocs du texte séparés par une ligne vide. */
function blocksOf(input) {
  if (Array.isArray(input.sections) && input.sections.length) {
    return input.sections
      .map((s) => ({ heading: String((s && s.heading) || '').trim(), body: String((s && s.text) || '').trim() }))
      .filter((b) => b.heading || b.body);
  }
  return String(input.text || '')
    .split(/\n[ \t]*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((body) => ({ heading: '', body }));
}

const render = (b) => [b.heading, b.body].filter(Boolean).join('\n');

/** Coupe une suite de lignes en morceaux de `max` caractères au plus, entre deux lignes si possible. */
function packLines(lines, max, prefix = '') {
  const out = [];
  let cur = '';
  const room = Math.max(1, max - (prefix ? prefix.length + 1 : 0));
  const push = () => {
    if (cur) out.push(prefix ? `${prefix}\n${cur}` : cur);
    cur = '';
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    if (cur && cur.length + 1 + line.length > room) push();
    if (line.length > room) {
      for (let i = 0; i < line.length; i += room) {
        push();
        cur = line.slice(i, i + room);
      }
      continue;
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  push();
  return out;
}

/** Une section trop longue est coupée entre ses paragraphes ; chaque partie garde son titre. */
function splitBlock(block, max) {
  const whole = render(block);
  if (whole.length <= max) return [whole];
  const heading = block.heading && block.heading.length < max / 4 ? block.heading : '';
  const lines = (heading ? block.body : whole).split('\n');
  return packLines(lines, max, heading);
}

/**
 * Morceaux de la page : [{ text, diagramsText }]. Les sections sont regroupées tant que le morceau
 * ne dépasse pas `chunkChars` ; les lignes de schéma suivent, regroupées de la même façon.
 */
function chunkPage(input, chunkChars) {
  const max = Math.max(200, chunkChars || 12000);
  const units = [];
  for (const b of blocksOf(input)) for (const s of splitBlock(b, max)) units.push({ kind: 'text', s });
  const diagramLines = String(input.diagramsText || '').split('\n');
  for (const s of packLines(diagramLines, max)) units.push({ kind: 'diagram', s });

  const chunks = [];
  let cur = null;
  const size = (c) => c.text.join(SEP).length + c.diagrams.join('\n').length;
  for (const u of units) {
    if (cur && size(cur) + SEP.length + u.s.length > max) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { text: [], diagrams: [] };
    (u.kind === 'text' ? cur.text : cur.diagrams).push(u.s);
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => ({ text: c.text.join(SEP), diagramsText: c.diagrams.join('\n') }));
}

/**
 * @param {object} llm   client créé par createLlmClient
 * @param {object} input { title, ancestors, space, updatedAt, today (AAAA-MM-JJ), sections?|text, diagramsText, apps, consignes, knownApps? }
 * @param {object} [opts] { chunkChars = 12000, maxTokens } (l'appelant passe config.llm.maxTokens.extract)
 * @returns {Promise<Reading>}
 */
async function readPage(llm, input, { chunkChars = 12000, maxTokens = 4096 } = {}) {
  const chunks = chunkPage(input, chunkChars);
  // Page sans texte ni schéma : rien à lire, pas d'appel.
  if (!chunks.length) return sanitizeReading({});

  const readings = [];
  const known = [...(input.knownApps || [])];
  for (let i = 0; i < chunks.length; i++) {
    const messages = buildReadingMessages({
      title: input.title,
      ancestors: input.ancestors,
      space: input.space,
      updatedAt: input.updatedAt,
      today: input.today,
      text: chunks[i].text,
      diagramsText: chunks[i].diagramsText,
      apps: input.apps,
      consignes: input.consignes,
      knownApps: i > 0 ? known : input.knownApps,
      part: { index: i + 1, count: chunks.length },
    });
    // Une erreur (réponse vide, coupée, JSON illisible, réseau) remonte telle quelle.
    const raw = await llm.chatJson({ task: 'extract', messages, temperature: 0, maxTokens, schema: READING_SCHEMA });
    const reading = sanitizeReading(raw);
    readings.push(reading);
    for (const a of reading.applications) if (!known.includes(a.name)) known.push(a.name);
  }
  return mergeReadings(readings);
}

module.exports = { readPage, chunkPage, READING_VERSION };
