#!/usr/bin/env node
'use strict';
/**
 * Récupère les pages Confluence des espaces listés dans CONFLUENCE_SPACES vers CONFLUENCE_EXPORT_DIR.
 * Seules les pages nouvelles ou modifiées sont téléchargées ; les pages supprimées sont retirées de l'export.
 *
 * Usage :
 *   node scripts/fetch-confluence.js                 passage incrémental (le premier passage récupère tout)
 *   node scripts/fetch-confluence.js --list-spaces   affiche les espaces visibles (pour remplir CONFLUENCE_SPACES)
 *   node scripts/fetch-confluence.js --dry-run       compte ce qui serait téléchargé, sans rien écrire
 *   node scripts/fetch-confluence.js --limit 20      20 pages au plus (test ; aucune suppression)
 *   node scripts/fetch-confluence.js --full          retélécharge tout (ex. une fois par semaine : titres des pages parentes)
 *   node scripts/fetch-confluence.js --spaces A,B    autres espaces que ceux du .env
 *
 * Ensuite : node scripts/sync-confluence.js (analyse), éventuellement avec --llm.
 */
const config = require('../src/config');
const { createConfluenceApi } = require('../src/fetch/confluenceApi');
const { fetchSpaces } = require('../src/fetch/confluenceFetcher');
const { createLogger } = require('../src/lib/logger');

const log = createLogger('fetch-confluence');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function main() {
  const c = config.confluence;
  const api = createConfluenceApi({ baseUrl: c.baseUrl, token: c.token, user: c.user, password: c.password, timeoutMs: c.timeoutMs }, { logger: log });

  if (args.includes('--list-spaces')) {
    const spaces = await api.listSpaces();
    for (const s of spaces) console.log(`${s.key}\t${s.name}`);
    log.info(`${spaces.length} espaces. Mettez les clés voulues dans CONFLUENCE_SPACES (séparées par des virgules).`);
    return;
  }

  const spaces = arg('--spaces') ? arg('--spaces').split(',').map((s) => s.trim()).filter(Boolean) : c.spaces;
  if (!spaces.length) {
    log.error('CONFLUENCE_SPACES vide dans backend/.env (lancez --list-spaces pour voir les clés)');
    process.exit(1);
  }
  const t0 = Date.now();
  log.info(`espaces : ${spaces.join(', ')} -> ${c.exportDir}`);
  const { stats, errors } = await fetchSpaces({
    api,
    root: c.exportDir,
    spaces,
    logger: log,
    options: {
      full: args.includes('--full'),
      dryRun: args.includes('--dry-run'),
      limit: arg('--limit') ? Number(arg('--limit')) : Infinity,
      concurrency: c.concurrency,
      downloadImages: c.downloadImages,
      maxAttachmentBytes: c.maxAttachmentMb * 1024 * 1024,
    },
  });
  log.info(`terminé en ${Math.round((Date.now() - t0) / 1000)} s`, { ...stats, http: api.stats });
  if (errors.length) {
    log.warn(`${errors.length} erreur(s)`, errors.slice(0, 20));
    process.exit(2);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
