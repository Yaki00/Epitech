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
 *   node scripts/sync-confluence.js            étape sans IA (structure, liens, draw.io)
 *   node scripts/sync-confluence.js --llm      + extraction des relations par IA
 *   node scripts/sync-confluence.js --force    retraite même les pages inchangées
 *   node scripts/sync-confluence.js --limit 20 ne traite que 20 pages (test)
 */
const fs = require('fs');
const config = require('../src/config');
const { openStore, acquireLock } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { ingestConfluencePage, documentId } = require('../src/ingest/confluence');
const { readExportPages, exportHash, analyseEntry, loadDiagrams } = require('../src/ingest/confluenceExport');
const { extractRelations, applyRelations, chunkText } = require('../src/enrich/relations');
const { createLlmClient } = require('../src/lib/llmClient');
const { createLogger } = require('../src/lib/logger');

const log = createLogger('sync-confluence');
const args = process.argv.slice(2);
const opt = {
  llm: args.includes('--llm'),
  force: args.includes('--force'),
  limit: args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity,
};
const FLUSH_EVERY = 100; // sauvegarde régulière : une synchro interrompue garde ce qui est fait

async function main() {
  const dir = config.confluence.exportDir;
  if (!fs.existsSync(dir)) {
    log.error(`Dossier d'export introuvable : ${dir} (CONFLUENCE_EXPORT_DIR dans backend/.env)`);
    process.exit(1);
  }
  const release = acquireLock(config.dataDir);
  const repo = createRepo(openStore(config.dataDir));
  const llm = opt.llm ? createLlmClient(config.llm) : null;
  const runId = repo.startRun(opt.llm ? 'confluence+llm' : 'confluence');
  const stats = { pages: 0, skipped: 0, errors: 0, mentions: 0, diagramLinks: 0, diagramsMissing: 0, obsoleteFragments: 0, llmRelations: 0, unresolved: 0 };
  const llmJobs = [];

  try {
    for (const entry of readExportPages(dir)) {
      if (stats.pages + stats.skipped >= opt.limit) break;
      if (entry.error) {
        stats.errors++;
        repo.recordError(runId, { source: 'confluence', ref: entry.ref, step: 'read', message: entry.error.message });
        log.warn(`${entry.ref} illisible : ${entry.error.message}`);
        continue;
      }
      const { p } = entry;
      const docId = `confluence:${p.id}`;
      const hash = exportHash(entry);
      const prev = repo.getDocument(docId);
      const unchanged = prev && prev.content_hash === hash && prev.status !== 'error';
      if (unchanged && !opt.force && (!opt.llm || prev.status === 'enriched')) {
        stats.skipped++;
        continue;
      }
      const docBase = { id: docId, source: 'confluence', title: p.title, url: p.url, version: p.version, updatedAt: p.updatedAt, contentHash: hash };
      try {
        const page = analyseEntry(entry);
        const diagrams = loadDiagrams(dir, entry, page);
        const docAttrs = { folder: entry.ref, parentId: p.parentId || null, ancestors: p.ancestors || [], images: entry.imageFiles.length, diagramsMissing: diagrams.missing };
        const r = ingestConfluencePage(repo, page, { drawioResults: diagrams.results, url: p.url, attrs: docAttrs });
        stats.pages++;
        stats.mentions += r.mentions;
        stats.diagramLinks += r.diagramLinks;
        stats.diagramsMissing += diagrams.missing.length;
        stats.obsoleteFragments += page.obsoleteFragments || 0;
        stats.unresolved += r.unresolved.length;
        repo.saveDocument({ ...docBase, status: 'parsed', attrs: { obsoleteFragments: page.obsoleteFragments || 0, sections: page.sections.length, tables: page.tables.length } });

        if (llm) {
          // toutes les sections partent en parallèle (la concurrence est limitée par le client LLM)
          const nodeId = `document:${documentId(p.id)}`;
          const jobs = page.sections.flatMap((s) =>
            chunkText(s.text).map((text) =>
              extractRelations(llm, { pageTitle: page.title, section: { heading: s.heading, text }, hints: page.entities }).then((res) =>
                applyRelations(repo, res, { sourceRef: p.id, docId: nodeId })
              )
            )
          );
          llmJobs.push(
            Promise.allSettled(jobs).then((results) => {
              const failures = results.filter((x) => x.status === 'rejected');
              stats.llmRelations += results.filter((x) => x.status === 'fulfilled').reduce((a, x) => a + x.value, 0);
              if (failures.length) {
                stats.errors++;
                const message = failures.map((f) => f.reason.message).join(' | ');
                repo.recordError(runId, { source: 'confluence', ref: p.id, step: 'llm', message });
                repo.saveDocument({ ...docBase, status: 'error', error: message });
              } else {
                repo.saveDocument({ ...docBase, status: 'enriched' });
              }
            })
          );
        }
      } catch (err) {
        stats.errors++;
        repo.recordError(runId, { source: 'confluence', ref: p.id || entry.ref, step: 'parse', message: err.message });
        repo.saveDocument({ ...docBase, status: 'error', error: err.message });
        log.warn(`page ${p.id} (${p.title}) en erreur : ${err.message}`);
      }
      const done = stats.pages + stats.skipped;
      if (done % FLUSH_EVERY === 0) {
        repo.flush();
        log.info('progression', stats);
      }
    }

    await Promise.all(llmJobs);
    const status = stats.errors ? 'partial' : 'success';
    repo.finishRun(runId, { status, stats: { ...stats, llm: llm ? llm.stats : undefined } });
    log.info(`terminé (${status})`, { ...stats, llm: llm ? llm.stats : undefined });
  } catch (err) {
    repo.finishRun(runId, { status: 'error', stats, error: err.message });
    throw err;
  } finally {
    repo.flush();
    release();
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
