#!/usr/bin/env node
'use strict';
/**
 * Résumé IA de chaque application, à partir de ses pages Confluence et des faits d'inventaire.
 * Le résumé s'affiche dans la fiche de l'application (encart « Résumé IA »).
 * Seules les applications dont les pages ou les faits ont changé sont refaites.
 *
 * Usage :
 *   node scripts/summarize-apps.js            applications du périmètre (toutes s'il n'y a pas de périmètre)
 *   node scripts/summarize-apps.js --force    refait tous les résumés
 *   node scripts/summarize-apps.js OrderHub   une seule application (nom)
 * À lancer après sync-confluence.js (inclus dans npm run sync:all, sauf avec --no-llm).
 */
const config = require('../src/config');
const { openStore, acquireLock } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { createLlmClient } = require('../src/lib/llmClient');
const { createLogger } = require('../src/lib/logger');
const { summaryInputs, summarizeApplication, saveSummary } = require('../src/enrich/summary');

const log = createLogger('summarize-apps');
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());

async function main() {
  const release = acquireLock(config.dataDir);
  const repo = createRepo(openStore(config.dataDir));
  const llm = createLlmClient(config.llm);
  const runId = repo.startRun('summary');
  const stats = { applications: 0, summarized: 0, unchanged: 0, withoutPages: 0, errors: 0 };
  try {
    const all = repo.listByType('application');
    const scoped = all.some((a) => a.attrs.perimeter) ? all.filter((a) => a.attrs.perimeter) : all;
    const apps = only.length ? scoped.filter((a) => only.includes(a.name.toLowerCase())) : scoped;
    stats.applications = apps.length;
    await Promise.all(
      apps.map(async (app) => {
        const inputs = summaryInputs(repo, app);
        if (!inputs.docs.length) {
          stats.withoutPages++;
          return;
        }
        if (!force && app.attrs.summaryHash === inputs.hash) {
          stats.unchanged++;
          return;
        }
        try {
          const summary = await summarizeApplication(llm, app, inputs);
          saveSummary(repo, app, summary, inputs);
          stats.summarized++;
          log.info(`${app.name} : résumé fait (${inputs.docs.length} pages)`);
        } catch (err) {
          stats.errors++;
          repo.recordError(runId, { source: 'summary', ref: app.name, step: 'llm', message: err.message });
          log.warn(`${app.name} : ${err.message}`);
        }
      })
    );
    repo.finishRun(runId, { status: stats.errors ? 'partial' : 'success', stats: { ...stats, llm: llm.stats } });
    log.info('terminé', stats);
  } catch (err) {
    repo.finishRun(runId, { status: 'error', stats, error: err.message });
    throw err;
  } finally {
    repo.flush();
    release();
  }
  process.exit(stats.errors ? 1 : 0);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
