'use strict';
/**
 * Clés des serveurs : le même serveur peut apparaître sous la forme "SRV01",
 * "srv01.domaine.local" ou "10.1.2.3". On calcule une clé canonique et des alias
 * pour retrouver le nœud de l'inventaire (aucun repérage dans un texte libre ici).
 */

/** Octet valide : 0 à 255, sans zéro en tête (« 01 » est un morceau de téléphone, pas une IP). */
const isValidOctet = (o) => (o === '0' || /^[1-9]\d{0,2}$/.test(o)) && Number(o) <= 255;

function isIPv4(s) {
  const parts = String(s).trim().split('.');
  return parts.length === 4 && parts.every(isValidOctet);
}

/** Clé canonique d'un serveur : nom court en minuscules (ou IP telle quelle). */
function canonicalHost(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  if (isIPv4(s)) return s;
  return s.split('.')[0];
}

/** Toutes les formes sous lesquelles on peut retrouver ce serveur. */
function hostAliases(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!s) return [];
  const out = new Set([s]);
  if (!isIPv4(s)) out.add(s.split('.')[0]);
  return [...out];
}

module.exports = { canonicalHost, hostAliases, isIPv4 };
