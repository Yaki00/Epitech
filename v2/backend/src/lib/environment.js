'use strict';
/**
 * Environnements (PRD, STG, DEV) et criticité des applications.
 * Aucune déduction depuis le nom d'un serveur : une valeur absente ou inconnue donne null
 * (« Non précisé »).
 */

const ENVS = ['PRD', 'STG', 'DEV'];

// Synonymes réglables (bloc « environnements » de mappings.json) : { PRD: ['production'], ... } déjà clés
let extra = {};

function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/** Synonymes d'environnement en plus des valeurs actuelles ; null remet les valeurs par défaut. */
function configureEnvironments(synonyms) {
  extra = {};
  if (!synonyms || typeof synonyms !== 'object') return;
  for (const env of ENVS) {
    const list = synonyms[env];
    if (Array.isArray(list)) extra[env] = list.map(fold).filter(Boolean);
  }
}

/** Lit le bloc facultatif « environnements » d'un fichier mappings.json (absent ou illisible : défauts). */
function configureEnvironmentsFromFile(file) {
  try {
    const m = JSON.parse(require('fs').readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    configureEnvironments(m && m.environnements);
  } catch (_) {
    configureEnvironments(null);
  }
}

/** Valeur libre de l'APM vers PRD, STG, DEV ou null. */
function normalizeEnv(value) {
  const v = fold(value);
  if (['prd', 'prod', 'production'].includes(v)) return 'PRD';
  if (['stg', 'stage', 'staging', 'preprod', 'preproduction'].includes(v)) return 'STG';
  if (['dev', 'development', 'developpement'].includes(v)) return 'DEV';
  for (const env of ENVS) if (v && (extra[env] || []).includes(v)) return env;
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

module.exports = { ENVS, normalizeEnv, configureEnvironments, configureEnvironmentsFromFile, serverEnv, appCriticality };
