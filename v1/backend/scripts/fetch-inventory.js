#!/usr/bin/env node
'use strict';
/**
 * Télécharge les exports CSV qui ont un lien direct (ex. la marketplace), au plus une fois par jour,
 * et remplace l'ancien fichier seulement si le contenu a changé.
 *
 * Une source de config/mappings.json est téléchargeable si elle a "downloadEnv" (ex. "MARKETPLACE")
 * et que <downloadEnv>_URL est rempli dans backend/.env. Le fichier écrit est son "file"
 * (ou "downloadTo" si "file" contient *).
 *
 * Usage :
 *   node scripts/fetch-inventory.js               toutes les sources avec un lien
 *   node scripts/fetch-inventory.js marketplace   une seule
 *   node scripts/fetch-inventory.js --force       retélécharge même si déjà vérifié aujourd'hui
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { downloadIfNeeded, downloadSettings } = require('../src/fetch/download');
const { createLogger } = require('../src/lib/logger');

const log = createLogger('fetch-inventory');
const args = process.argv.slice(2);
const force = args.includes('--force');
const wanted = args.filter((a) => !a.startsWith('--'));

async function main() {
  if (!fs.existsSync(config.inventory.mappingFile)) {
    log.error(`Fichier de mapping introuvable : ${config.inventory.mappingFile}`);
    process.exit(1);
  }
  const mappings = JSON.parse(fs.readFileSync(config.inventory.mappingFile, 'utf8').replace(/^﻿/, ''));
  let failed = false;
  let done = 0;
  for (const [source, m] of Object.entries(mappings)) {
    if (source.startsWith('_') || (wanted.length && !wanted.includes(source)) || !m.downloadEnv) continue;
    const settings = downloadSettings(m.downloadEnv);
    if (!settings.url) {
      if (wanted.includes(source)) log.warn(`${source} : ${m.downloadEnv}_URL vide dans backend/.env`);
      continue;
    }
    const pattern = m.downloadTo || m.file;
    if (!pattern || pattern.includes('*')) {
      log.error(`${source} : "file" contient * ; indiquez "downloadTo" (chemin du fichier à écrire) dans mappings.json`);
      failed = true;
      continue;
    }
    const target = path.resolve(config.root, pattern);
    try {
      const r = await downloadIfNeeded({ url: settings.url, target, auth: settings, force });
      done++;
      const size = r.size ? ` (${Math.round(r.size / 1024)} Ko)` : '';
      log.info(`${source} : ${r.status}${size} -> ${target}`);
    } catch (err) {
      failed = true;
      log.error(`${source} : ${err.message}`);
    }
  }
  if (!done && !failed) log.info('aucune source avec un lien de téléchargement (downloadEnv + <PREFIXE>_URL)');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
