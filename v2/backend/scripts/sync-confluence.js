#!/usr/bin/env node
'use strict';
/**
 * Traite les pages Confluence déjà exportées par le fetcher (Lyra n'appelle pas Confluence).
 *
 * Entrée (CONFLUENCE_EXPORT_DIR) : un dossier par page, à n'importe quelle profondeur
 *   <dossier>/metadata.json + page.html (+ page.storage.xml, images/, attachments/ optionnels)
 * Le format historique pages/*.json + attachments/<pageId>/ est toujours accepté.
 *
 * Usage :
 *   node scripts/sync-confluence.js --llm      lecture des pages par l'IA, vérifiée par le code
 *   node scripts/sync-confluence.js            sans IA : pages lues et stockées, rien n'est déduit
 *   node scripts/sync-confluence.js --force    relit même les pages inchangées
 *   node scripts/sync-confluence.js --limit 20 ne traite que 20 pages (test)
 *
 * Chaque page est lue par l'IA (nature, période, applications, serveurs, liens, responsables, avec
 * une citation), puis le code garde ce qui est cité dans la page et le rapproche des inventaires
 * et du périmètre (config/perimeter.json). Les consignes de config/consignes-ia.md sont données à
 * l'IA ; les modifier relance la lecture des pages au passage suivant. Rapports CSV dans data/rapports/.
 * Les pages d'exploitation (incident, version, exploitation, installation, autre) donnent aussi des fiches, écrites dans le
 * graphe ; les sections de toutes les pages sont écrites dans data/knowledge-sections.json (recherche de second recours).
 * Lancer l'import des inventaires AVANT : ils servent de référence à la vérification.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { openStore, acquireLock } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter } = require('../src/perimeter/perimeter');
const { loadConsignes } = require('../src/reading/consignes');
const { runConfluenceSync } = require('../src/reading/syncPages');
const { createReadingMock } = require('../src/reading/mockReadings');
const { readUnmatchedHosts } = require('../src/naemon/poller');
const { configureEnvironmentsFromFile } = require('../src/lib/environment');
const { createLlmClient } = require('../src/lib/llmClient');
const { createLogger } = require('../src/lib/logger');

const log = createLogger('sync-confluence');
const args = process.argv.slice(2);
const opt = {
  llm: args.includes('--llm'),
  force: args.includes('--force'),
  limit: args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity,
};
if (args.includes('--no-triage')) log.warn("--no-triage est ignoré : il n'y a plus de tri séparé, chaque page est lue une fois par l'IA");

/** Hôtes supervisés par Naemon mais absents des inventaires (corroborent un serveur hors inventaire). */
const naemonHosts = () => readUnmatchedHosts(path.join(config.dataDir, 'naemon-status.json'));

function createLlm() {
  if (!opt.llm) return null;
  if (config.llm.mock) {
    log.warn(`LLM_MOCK actif : lectures simulées${config.llm.mockReadingsFile ? ` (${config.llm.mockReadingsFile})` : ' (pages vides)'}`);
    return createLlmClient({ ...config.llm, cacheDir: '' }, { mockHandler: createReadingMock(config.llm.mockReadingsFile) });
  }
  return createLlmClient(config.llm);
}

async function main() {
  const dir = config.confluence.exportDir;
  if (!fs.existsSync(dir)) {
    log.error(`Dossier d'export introuvable : ${dir} (CONFLUENCE_EXPORT_DIR dans backend/.env)`);
    process.exit(1);
  }
  configureEnvironmentsFromFile(config.inventory.mappingFile);
  const release = acquireLock(config.dataDir);
  const repo = createRepo(openStore(config.dataDir));
  try {
    const perimeter = loadPerimeter(config.perimeterFile);
    if (perimeter) log.info(`périmètre : ${perimeter.applications.length} applications`);
    const consignes = loadConsignes(config.consignesFile);
    log.info(consignes.text ? `consignes : ${consignes.chars} caractères${consignes.truncated ? ' (coupées)' : ''}` : 'consignes : aucune (config/consignes-ia.md absent ou vide)');
    const llm = createLlm();
    if (!llm) log.warn("sans --llm : les pages sont lues et stockées, mais rien n'en est déduit (ni serveurs, ni rattachements, ni nature)");
    const { status, stats } = await runConfluenceSync({
      repo,
      exportDir: dir,
      llm,
      perimeter,
      consignes,
      naemonHosts: naemonHosts(),
      reportsDir: config.reportsDir,
      knowledgeSectionsFile: path.join(config.dataDir, 'knowledge-sections.json'),
      force: opt.force,
      limit: opt.limit,
      chunkChars: config.reading.chunkChars,
      maxTokens: config.llm.maxTokens.extract,
      maxInFlight: Math.max(2, (config.llm.concurrency || 4) * 2),
      log,
    });
    log.info(`terminé (${status})`, { ...stats, llm: llm ? llm.stats : undefined });
  } finally {
    repo.flush();
    release();
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
