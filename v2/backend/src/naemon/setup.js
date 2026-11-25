'use strict';
/**
 * Relève Naemon de production : construit le poller d'après la configuration (thruk ou csv).
 * NAEMON_SOURCE=off : pas de poller. Une configuration invalide ou une erreur au démarrage
 * n'empêche jamais le serveur de démarrer : l'erreur est visible dans /api/status.
 */
const fs = require('fs');
const path = require('path');
const { createPoller } = require('./poller');
const { createFetchRaw } = require('./source');
const { computeGaps, writeGapsReport } = require('./gaps');
const { loadPerimeter, createMatcher } = require('../perimeter/perimeter');

/** @returns {object|null} poller démarré (ou null si la source est off) */
function startNaemonPoller({ config, repo, logger = null }) {
  const n = config.naemon || {};
  if (!['thruk', 'csv'].includes(n.source)) return null;

  let mapping = null;
  try {
    if (config.inventory && config.inventory.mappingFile && fs.existsSync(config.inventory.mappingFile)) {
      mapping = JSON.parse(fs.readFileSync(config.inventory.mappingFile, 'utf8').replace(/^﻿/, ''));
    }
  } catch (err) {
    logger && logger.warn('mappings.json illisible pour Naemon', { erreur: err.message });
  }

  // le périmètre est relu à chaque relève (modifiable sans redémarrage)
  const matcher = () => {
    try {
      const p = loadPerimeter(config.perimeterFile);
      return p ? createMatcher(p, repo) : null;
    } catch (err) {
      logger && logger.warn('périmètre illisible pour Naemon', { erreur: err.message });
      return null;
    }
  };

  let fetchRaw;
  try {
    fetchRaw = createFetchRaw(config, { mapping });
  } catch (err) {
    logger && logger.error('Naemon non démarré', { erreur: err.message });
    return null;
  }

  const poller = createPoller({
    cfg: n,
    repo,
    matcher,
    fetchRaw,
    file: path.join(config.dataDir, 'naemon-status.json'),
    // rapport d'écarts à jour après chaque relève réussie
    onOk: (status) => writeGapsReport(config.reportsDir, computeGaps(repo, status)),
  });
  poller.start().catch((err) => logger && logger.error('première relève Naemon en échec', { erreur: err.message }));
  return poller;
}

module.exports = { startNaemonPoller };
