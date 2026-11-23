'use strict';
/**
 * Environnements (PRD, STG, DEV) et criticité des applications.
 * Aucune déduction depuis le nom d'un serveur : une valeur absente ou inconnue donne null
 * (« Non précisé »).
 */

const ENVS = ['PRD', 'STG', 'DEV'];

/** Valeur libre de l'APM vers PRD, STG, DEV ou null. */
function normalizeEnv(value) {
  const v = String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (['prd', 'prod', 'production'].includes(v)) return 'PRD';
  if (['stg', 'stage', 'staging', 'preprod', 'preproduction'].includes(v)) return 'STG';
  if (['dev', 'development', 'developpement'].includes(v)) return 'DEV';
  return null;
}

/** Environnement d'un serveur : attribut environment, puis usedFor (anciens stores), sinon null. */
function serverEnv(node) {
  const a = (node && node.attrs) || {};
  return normalizeEnv(a.environment) || normalizeEnv(a.usedFor) || null;
}

/** Criticité d'une application : criticality, sinon confidentiality (colonne AI de l'APM). */
function appCriticality(node) {
  const a = (node && node.attrs) || {};
  return a.criticality || a.confidentiality || null;
}

module.exports = { ENVS, normalizeEnv, serverEnv, appCriticality };
