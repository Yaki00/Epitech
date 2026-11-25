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
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\s*(?:->|=>|\u2192)\s*/g, ' -> ')
    .replace(/\s*"\s*/g, '"')
    .replace(/[|\s   ]+/g, ' ')
    .trim();
}

/**
 * Partie avant le `@` d'une adresse de forme `nom@domaine` : seule cette partie est personnelle
 * (`prenom.nom@...`) ; le domaine, ou la machine d'une commande `ssh deploy@serveur.domaine`, ne l'est pas.
 */
const EMAIL_USER = /[A-Za-z0-9._%+-]+@(?=[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** Texte sans la partie personnelle des adresses : `ssh deploy@srv01.domaine.lan` devient `ssh srv01.domaine.lan`. */
function stripEmailUser(s) {
  return String(s == null ? '' : s).replace(EMAIL_USER, '');
}

/**
 * La citation se retrouve-t-elle dans le texte ? Les deux côtés sont comparés sans la partie personnelle
 * des adresses, retirée des citations au nettoyage (`cleanEvidence`).
 */
function hasEvidence(haystack, quote) {
  const q = normalizeText(stripEmailUser(quote));
  if (q.length < 4 || !/[\p{L}\p{N}]/u.test(q)) return false;
  return normalizeText(stripEmailUser(haystack)).includes(q);
}

/** Forme compacte d'un nom pour la comparaison : texte normalisé sans espaces, tirets, soulignés ni points. */
const compact = (s) => normalizeText(s).replace(/[\s\-_.'"]+/g, '');

/**
 * La citation nomme-t-elle l'élément ? Vrai si l'un des noms donnés (nom, forme écrite, nom court
 * d'un FQDN...) se retrouve dans la citation, sur texte normalisé comme `hasEvidence` (casse, accents,
 * guillemets, espaces, tirets). Un nom de moins de 4 caractères, ou une IP, doit y être un mot entier.
 */
function quoteNames(quote, names) {
  const q = normalizeText(quote);
  const qc = compact(quote);
  for (const raw of names || []) {
    const n = normalizeText(raw);
    if (!n || !/[\p{L}\p{N}]/u.test(n)) continue;
    const nc = compact(raw);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(n)) {
      if (new RegExp(`(^|[^\\d.])${n.replace(/\./g, '\\.')}($|[^\\d])`).test(q)) return true;
    } else if (nc.length >= 4) {
      if (qc.includes(nc)) return true;
    } else {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(q)) return true;
    }
  }
  return false;
}

module.exports = { hasEvidence, normalizeText, quoteNames, stripEmailUser };
