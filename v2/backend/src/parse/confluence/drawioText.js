'use strict';
/**
 * Schémas draw.io mis en texte pour la lecture IA : le code ne décide plus du sens d'une flèche,
 * il écrit ce que le fichier contient et l'IA qualifie le lien.
 *   « Schéma <nom> : <boîte A> → <boîte B> (<libellé>) »  une ligne par flèche
 *   « Schéma <nom> : <boîte> contient <boîte> »          une ligne par inclusion
 * Une flèche dont une extrémité n'a pas de libellé n'apporte rien de lisible : elle est omise.
 */

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Accepte les résultats de parseDrawio ({ pages: [...] }) ou directement des pages ({ name, edges, containment }). */
function pagesOf(results) {
  const out = [];
  for (const r of Array.isArray(results) ? results : results ? [results] : []) {
    if (!r) continue;
    if (Array.isArray(r.pages)) out.push(...r.pages.filter(Boolean));
    else out.push(r);
  }
  return out;
}

function diagramsToText(drawioResults) {
  const lines = [];
  for (const page of pagesOf(drawioResults)) {
    const name = clean(page.name) || 'sans nom';
    for (const e of page.edges || []) {
      const from = clean(e.sourceLabel);
      const to = clean(e.targetLabel);
      if (!from || !to) continue;
      const label = clean(e.label);
      lines.push(`Schéma ${name} : ${from} → ${to}${label ? ` (${label})` : ''}`);
    }
    for (const c of page.containment || []) {
      const parent = clean(c.parentLabel);
      const child = clean(c.childLabel);
      if (parent && child) lines.push(`Schéma ${name} : ${parent} contient ${child}`);
    }
  }
  return [...new Set(lines)].join('\n');
}

module.exports = { diagramsToText };
