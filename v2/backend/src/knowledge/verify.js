'use strict';
/**
 * Vérification par le code des fiches lues par l'IA (type FicheReading, voir ./schema) : citations
 * retrouvées dans la page, rapprochement avec le périmètre et l'inventaire, secrets et coordonnées
 * personnelles écartés. Ne modifie rien. Voir docs/2026-11-24-v2-assistant-operationnel-conception.md.
 *
 * verifyFiches(reading, { pageText, repo, matcher }) -> { fiches: VerifiedFiche[], rejected }
 * VerifiedFiche = {
 *   kind, title: Item, section, date: Item|null, fields: { nom: Item }, lists: { nom: Item[] },
 *   appIds: string[],      applications du périmètre reconnues (matcher.resolveAppName)
 *   serverIds: string[],   serveurs connus de l'inventaire (repo.resolve)
 *   unresolved: string[],  noms d'applications ou de serveurs cités (citation vérifiée) mais inconnus :
 *                          gardés en texte seulement, ni identifiants ni rejet
 *   tickets: string[],     éléments de lists.tickets tels qu'écrits, sans doublon
 *   keywords, replaces: Item|null, fixes: Item|null,
 * }
 * rejected = [{ what, reason: 'no_evidence'|'evidence_mismatch'|'secret'|'out_of_scope' }]
 * no_evidence : la citation n'est pas dans la page. evidence_mismatch : la citation ne contient ni
 * le texte de l'élément ni un mot de 4 lettres ou plus de ce texte (comparaison comme hasEvidence).
 * secret : texte ou citation contenant un mot de passe, jeton ou clé (l'élément entier est retiré).
 * out_of_scope est réservé (aucune fiche n'est écartée pour application inconnue). Un titre rejeté
 * retire la fiche. Les adresses électroniques et numéros sont retirés des textes rendus.
 */
const { hasEvidence, normalizeText } = require('../reading/evidence');
const { cleanName, cleanEvidence, normKey } = require('../reading/schema');

const SECRET = /(mot de passe|password|passwd|pwd|tokens?|jeton|secrets?|api[ _-]?keys?)\s*[:=]\s*\S+/i;

/** La citation contient le texte ou un mot de 4 lettres ou plus du texte. */
function quoteMatchesText(quote, text) {
  const q = normalizeText(quote);
  const t = normalizeText(text);
  if (t && q.includes(t)) return true;
  const words = t.match(/\p{L}{4,}/gu) || [];
  return words.some((w) => q.includes(w));
}

function verifyFiches(reading, ctx) {
  const { pageText = '', repo, matcher } = ctx;
  const rejected = [];

  /** Élément vérifié et nettoyé, ou null (rejet noté). */
  function check(item, label = 'fiche') {
    if (!item) return null;
    const what = item.text;
    if (SECRET.test(item.text) || SECRET.test(item.evidence)) {
      rejected.push({ what: `élément masqué (secret) : ${label}`, reason: 'secret' });
      return null;
    }
    if (!hasEvidence(pageText, item.evidence)) {
      rejected.push({ what, reason: 'no_evidence' });
      return null;
    }
    if (!quoteMatchesText(item.evidence, item.text)) {
      rejected.push({ what, reason: 'evidence_mismatch' });
      return null;
    }
    const text = cleanName(item.text, true);
    const evidence = cleanEvidence(item.evidence, true);
    return text && evidence ? { text, evidence } : null;
  }
  const checkAll = (items, label) => (items || []).map((i) => check(i, label)).filter(Boolean);

  const fiches = [];
  for (const f of (reading && reading.fiches) || []) {
    const title = check(f.title, 'title');
    if (!title) continue;
    const fields = {};
    for (const [name, it] of Object.entries(f.fields || {})) {
      const v = check(it, `fields.${name}`);
      if (v) fields[name] = v;
    }
    const lists = {};
    for (const [name, items] of Object.entries(f.lists || {})) lists[name] = checkAll(items, `lists.${name}`);

    const appIds = [];
    const serverIds = [];
    const unresolved = [];
    const addUnique = (arr, v) => { if (!arr.includes(v)) arr.push(v); };
    for (const a of checkAll(f.apps, 'apps')) {
      const hit = matcher && matcher.resolveAppName(a.text);
      if (hit) addUnique(appIds, hit.app.id);
      else addUnique(unresolved, a.text);
    }
    for (const s of checkAll(f.servers, 'servers')) {
      const node = repo.resolve(s.text).find((n) => n.type === 'server');
      if (node) addUnique(serverIds, node.id);
      else addUnique(unresolved, s.text);
    }

    const tickets = [];
    const seen = new Set();
    for (const t of lists.tickets || []) {
      const k = normKey(t.text);
      if (!seen.has(k)) { seen.add(k); tickets.push(t.text); }
    }
    const keywords = [];
    for (const k of f.keywords || []) {
      if (SECRET.test(k)) { rejected.push({ what: 'élément masqué (secret) : keywords', reason: 'secret' }); continue; }
      const c = cleanName(k, true);
      if (c) keywords.push(c);
    }
    let section = null;
    if (f.section && SECRET.test(f.section)) rejected.push({ what: 'élément masqué (secret) : section', reason: 'secret' });
    else if (f.section) section = cleanName(f.section, true) || null;

    fiches.push({
      kind: f.kind, title, section,
      date: check(f.date, 'date'), fields, lists, appIds, serverIds, unresolved, tickets, keywords,
      replaces: check(f.replaces, 'replaces'), fixes: check(f.fixes, 'fixes'),
    });
  }
  return { fiches, rejected };
}

module.exports = { verifyFiches };
