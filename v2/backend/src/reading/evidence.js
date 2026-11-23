'use strict';
/**
 * Contrôle d'une citation : elle doit se retrouver dans le texte de la page (ou de ses schémas).
 * Comparaison sur texte normalisé : minuscules, sans accents, guillemets et apostrophes unifiés,
 * espaces (dont insécables et retours à la ligne) et barres de tableau réduits à une espace.
 */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’‚‛ʼ`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s*"\s*/g, '"')
    .replace(/[|\s   ]+/g, ' ')
    .trim();
}

function hasEvidence(haystack, quote) {
  const q = normalizeText(quote);
  if (!q) return false;
  return normalizeText(haystack).includes(q);
}

module.exports = { hasEvidence, normalizeText };
