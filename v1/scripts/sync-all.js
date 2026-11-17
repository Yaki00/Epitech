#!/usr/bin/env node
'use strict';
/**
 * Synchro complète, dans le bon ordre (commande unique, prévue pour une tâche planifiée) :
 *   1. récupération Confluence (seulement les pages nouvelles ou modifiées) si CONFLUENCE_BASE_URL est rempli
 *   2. téléchargement des exports CSV qui ont un lien (une fois par jour), puis import des inventaires (APM, marketplace)
 *   3. analyse Confluence, avec l'IA (seulement les pages nouvelles ou modifiées)
 * Une étape en échec n'empêche pas les suivantes de tourner sur les données déjà là ;
 * le code de sortie est non nul si une étape a échoué (visible par systemd / le Planificateur de tâches).
 *
 * Options : --no-fetch  --no-download  --no-llm  --no-inventory
 */
const { spawnSync } = require('child_process');
const path = require('path');

const backend = path.join(__dirname, '..', 'backend');
const args = process.argv.slice(2);
require(path.join(backend, 'node_modules', 'dotenv')).config({ path: path.join(backend, '.env'), quiet: true });

const steps = [
  { name: 'récupération Confluence', script: 'fetch-confluence.js', args: [], skip: args.includes('--no-fetch') || !process.env.CONFLUENCE_BASE_URL },
  { name: 'téléchargement des exports CSV', script: 'fetch-inventory.js', args: [], skip: args.includes('--no-download') || args.includes('--no-inventory') },
  { name: 'inventaires CSV', script: 'sync-inventory.js', args: [], skip: args.includes('--no-inventory') },
  { name: 'analyse Confluence', script: 'sync-confluence.js', args: args.includes('--no-llm') ? [] : ['--llm'], skip: false },
];

const t0 = Date.now();
const results = [];
for (const s of steps) {
  if (s.skip) {
    results.push([s.name, 'sautée']);
    continue;
  }
  console.log(`\n=== ${s.name} ===`);
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(backend, 'scripts', s.script), ...s.args], { cwd: backend, stdio: 'inherit' });
  const secs = Math.round((Date.now() - t) / 1000);
  results.push([s.name, r.status === 0 ? `ok (${secs} s)` : `ÉCHEC code ${r.status ?? r.signal} (${secs} s)`]);
}
console.log(`\n=== résumé (${Math.round((Date.now() - t0) / 1000)} s) ===`);
for (const [name, status] of results) console.log(`${status.startsWith('ÉCHEC') ? '✖' : '✔'} ${name} : ${status}`);
process.exit(results.some(([, st]) => st.startsWith('ÉCHEC')) ? 1 : 0);
