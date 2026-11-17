#!/usr/bin/env node
'use strict';
/**
 * Importe les inventaires CSV (marketplace, APM…) décrits dans config/mappings.json.
 * Usage : node scripts/sync-inventory.js [source…]
 *   ex : node scripts/sync-inventory.js marketplace
 *
 * "file" accepte un motif avec * (ex : "./data/raw/apm/apm_os_*.csv") : le fichier le plus récent est pris.
 */
const fs = require('fs');
const config = require('../src/config');
const { openStore, acquireLock } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { parseCsv } = require('../src/lib/csv');
const { ingestInventory, resolveInputFile } = require('../src/ingest/inventory');
const { createLogger } = require('../src/lib/logger');

const log = createLogger('sync-inventory');

function main() {
  if (!fs.existsSync(config.inventory.mappingFile)) {
    log.error(`Fichier de mapping introuvable : ${config.inventory.mappingFile} (copiez config/mappings.example.json)`);
    process.exit(1);
  }
  const mappings = JSON.parse(fs.readFileSync(config.inventory.mappingFile, 'utf8').replace(/^﻿/, ''));
  const wanted = process.argv.slice(2);
  const sources = Object.keys(mappings).filter((k) => !k.startsWith('_') && (!wanted.length || wanted.includes(k)));
  const release = acquireLock(config.dataDir);
  const repo = createRepo(openStore(config.dataDir));
  let failed = false;

  try {
    for (const source of sources) {
      const mapping = mappings[source];
      const runId = repo.startRun(source);
      try {
        const file = resolveInputFile(config.root, mapping.file);
        if (!file) throw new Error(`aucun fichier ne correspond à ${mapping.file}`);
        const { records, headers, delimiter } = parseCsv(fs.readFileSync(file, 'utf8'));
        log.info(`${source} : ${file} — ${records.length} lignes, séparateur "${delimiter}"`, { colonnes: headers });
        const stats = ingestInventory(repo, { source, records, mapping, runId });
        repo.finishRun(runId, { status: stats.errors ? 'partial' : 'success', stats: { ...stats, file } });
        log.info(`${source} terminé`, stats);
      } catch (err) {
        failed = true;
        repo.finishRun(runId, { status: 'error', error: err.message });
        log.error(`${source} en échec : ${err.message}`);
      }
    }
    log.info('Contenu du graphe', repo.countByType());
  } finally {
    repo.flush();
    release();
  }
  process.exit(failed ? 1 : 0);
}

main();
