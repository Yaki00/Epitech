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
const { parseCsv, decodeText } = require('../src/lib/csv');
const { ingestInventory, resolveInputFile, resolveMapping } = require('../src/ingest/inventory');
const { createLogger } = require('../src/lib/logger');
const { loadPerimeter, createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { writeCsvReport } = require('../src/lib/report');
const { createHistory } = require('../src/history/history');

const log = createLogger('sync-inventory');

function main() {
  if (!fs.existsSync(config.inventory.mappingFile)) {
    log.error(`Fichier de mapping introuvable : ${config.inventory.mappingFile} (copiez config/mappings.example.json)`);
    process.exit(1);
  }
  const mappings = JSON.parse(fs.readFileSync(config.inventory.mappingFile, 'utf8').replace(/^﻿/, ''));
  const wanted = process.argv.slice(2);
  const sources = Object.keys(mappings).filter((k) => !k.startsWith('_') && k !== 'naemon' && (!wanted.length || wanted.includes(k)));
  const release = acquireLock(config.dataDir);
  const repo = createRepo(openStore(config.dataDir));
  let failed = false;
  const perimeter = loadPerimeter(config.perimeterFile);
  let matcher = null;
  if (perimeter) {
    ensurePerimeterNodes(repo, perimeter);
    matcher = createMatcher(perimeter);
    log.info(`périmètre : ${perimeter.applications.length} applications (${perimeter.applications.map((a) => a.name).join(', ')})`);
  } else log.warn(`pas de périmètre (${config.perimeterFile} absent) : toutes les applications sont importées`);
  const nearRows = [];
  const history = createHistory(config.dataDir, { keep: config.history.keep });

  try {
    for (const source of sources) {
      const mapping = mappings[source];
      const runId = repo.startRun(source);
      try {
        const file = resolveInputFile(config.root, mapping.file);
        if (!file) {
          const message = `aucun fichier ne correspond à ${mapping.file}`;
          // source pas encore disponible (ex. marketplace) : sautée, sauf si on l'a demandée explicitement
          if (wanted.includes(source)) throw new Error(message);
          repo.finishRun(runId, { status: 'skipped', error: message });
          log.warn(`${source} sautée : ${message}`);
          continue;
        }
        const { text, encoding } = decodeText(fs.readFileSync(file));
        const { records, headers, delimiter } = parseCsv(text);
        log.info(`${source} : ${file} (${records.length} lignes, séparateur "${delimiter}", ${headers.length} colonnes, ${encoding})`);
        const { resolved } = resolveMapping(mapping, headers);
        if (resolved.length) log.info(`${source} : colonnes par lettre`, Object.fromEntries(resolved.map((r) => [r.ref, r.header])));
        const stats = ingestInventory(repo, { source, records, headers, mapping, matcher, runId });
        // un import n'est « complet » que sans erreur de ligne et avec au moins une ligne : sinon aucun retrait
        const { seen } = stats;
        const complete = stats.errors === 0 && records.length > 0 && seen.nodeIds.length > 0;
        delete stats.seen;
        const change = history.recordImport({ source, seen, attrsById: seen.attrsById, complete });
        if (change) log.info(`${source} : ${change.added.length} ajout(s), ${change.removed.length} retrait(s), ${change.changed.length} modification(s)`);
        if (!complete) log.warn(`${source} : import incomplet (${stats.errors} erreur(s), ${records.length} ligne(s)), aucun retrait appliqué`);
        if (stats.nearMisses) {
          log.warn(`${source} : noms proches d'une application du périmètre mais NON importés (à ajouter en alias si c'est la même)`, stats.nearMisses);
          for (const n of stats.nearMisses) nearRows.push([source, n]);
          delete stats.nearMisses;
        }
        repo.finishRun(runId, { status: stats.errors ? 'partial' : 'success', stats: { ...stats, file } });
        log.info(`${source} terminé`, stats);
      } catch (err) {
        failed = true;
        repo.finishRun(runId, { status: 'error', error: err.message });
        log.error(`${source} en échec : ${err.message}`);
      }
    }
    const retired = history.applyRetirements(repo);
    if (retired.nodes || retired.edges) log.info(`retraits : ${retired.nodes} serveur(s), ${retired.edges} lien(s) n'apparaissent plus dans les inventaires`);
    if (perimeter) {
      const file = writeCsvReport(config.reportsDir, 'inventaire-noms-proches', ['source', 'nom dans l\'export -> application du périmètre (lignes)'], nearRows);
      if (nearRows.length) log.info(`rapport : ${file}`);
    }
    log.info('Contenu du graphe', repo.countByType());
  } finally {
    repo.flush();
    release();
  }
  process.exit(failed ? 1 : 0);
}

main();
