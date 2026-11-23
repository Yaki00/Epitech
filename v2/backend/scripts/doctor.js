#!/usr/bin/env node
'use strict';
/**
 * Vérifie l'environnement AVANT de lancer quoi que ce soit, et affiche un rapport à copier-coller.
 * Usage : npm run doctor            (à la racine de v1, ou dans backend/)
 *         npm run doctor -- --no-llm   sans appel à la passerelle IA
 */
const fs = require('fs');
const path = require('path');

const results = [];
const ok = (m) => results.push(['OK  ', m]);
const ko = (m) => results.push(['ERR ', m]);
const warn = (m) => results.push(['WARN', m]);
const info = (m) => results.push(['INFO', m]);

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    ko(`${name} : ${err.message}`);
  }
}

function pkgVersion(name) {
  try {
    return require(`${name}/package.json`).version;
  } catch (_) {
    return null;
  }
}

async function main() {
  const noLlm = process.argv.includes('--no-llm');

  // 1. Node et plateforme
  const [major, minor] = process.versions.node.split('.').map(Number);
  info(`plateforme ${process.platform} ${process.arch}`);
  if (major === 16 && minor >= 20) ok(`Node ${process.versions.node}`);
  else if (major >= 16) warn(`Node ${process.versions.node} : le projet vise Node 16.20.x (doit fonctionner, non vérifié)`);
  else ko(`Node ${process.versions.node} : il faut Node 16.20 ou plus`);

  // 2. packages utilisés par le backend (les autres de package.json ne sont pas chargés)
  for (const name of ['express', 'dotenv']) {
    const v = pkgVersion(name);
    v ? ok(`package ${name} ${v}`) : ko(`package ${name} absent : lancez npm install dans backend/`);
  }

  let config;
  try {
    config = require('../src/config');
  } catch (err) {
    ko(`configuration illisible : ${err.message}`);
    return finish();
  }

  // 3. fichiers de configuration
  fs.existsSync(path.join(config.root, '.env')) ? ok('backend/.env présent') : warn('backend/.env absent (lancez npm run setup ou copiez .env.example)');
  // valeurs d'exemple encore présentes dans .env (ex : LLM_TOKEN=<jeton de la passerelle IA>)
  const envFile = path.join(config.root, '.env');
  if (fs.existsSync(envFile)) {
    const placeholders = fs
      .readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^\s*[A-Z_]+\s*=.*<[^>]+>/.test(l))
      .map((l) => l.split('=')[0].trim());
    if (placeholders.length) ko(`backend/.env : valeurs d'exemple à remplacer (<…>) : ${placeholders.join(', ')}`);
  }
  fs.existsSync(config.inventory.mappingFile) ? ok('config/mappings.json présent') : warn('config/mappings.json absent (copiez mappings.example.json)');
  try {
    const { loadPerimeter } = require('../src/perimeter/perimeter');
    const perimeter = loadPerimeter(config.perimeterFile);
    const example = path.join(config.root, 'config', 'perimeter.example.json');
    const sameAsExample = perimeter && fs.existsSync(example) && fs.readFileSync(example, 'utf8') === fs.readFileSync(config.perimeterFile, 'utf8');
    if (sameAsExample) ko("config/perimeter.json = exemple (OrderHub, Billing Engine) : y mettre vos applications, sinon l'import APM ne garde aucune ligne");
    else if (perimeter) ok(`périmètre : ${perimeter.applications.length} applications (${perimeter.applications.map((a) => a.name).join(', ')})`);
    else warn('config/perimeter.json absent : toutes les applications seront analysées (copiez perimeter.example.json)');
  } catch (err) {
    ko(`config/perimeter.json illisible : ${err.message}`);
  }

  // 4. API Confluence (récupération des pages)
  if (config.confluence.baseUrl) {
    await check('API Confluence', async () => {
      const { createConfluenceApi } = require('../src/fetch/confluenceApi');
      const c = config.confluence;
      const api = createConfluenceApi({ baseUrl: c.baseUrl, token: c.token, user: c.user, password: c.password, timeoutMs: 15000, maxRetries: 0 });
      const t0 = Date.now();
      await api.ping();
      ok(`Confluence joignable (${Date.now() - t0} ms), authentification acceptée`);
      if (!c.spaces.length) warn('CONFLUENCE_SPACES vide (node scripts/fetch-confluence.js --list-spaces)');
      else info(`espaces à récupérer : ${c.spaces.join(', ')}`);
    });
  } else info('CONFLUENCE_BASE_URL vide : récupération Confluence non configurée (export déjà présent ?)');

  // 5. export Confluence
  await check('export Confluence', async () => {
    const dir = config.confluence.exportDir;
    if (!fs.existsSync(dir)) return warn(`export Confluence absent : ${dir} (CONFLUENCE_EXPORT_DIR)`);
    const { findPageDirs, readExportPages } = require('../src/ingest/confluenceExport');
    const dirs = findPageDirs(dir);
    if (!dirs.length) return warn(`aucun dossier de page (metadata.json + page.html) dans ${dir}`);
    let unreadable = 0;
    let withStorage = 0;
    let withImages = 0;
    let withParent = 0;
    let versionZero = 0;
    let sample = null;
    for (const e of readExportPages(dir)) {
      if (e.error) unreadable++;
      else {
        if (e.storage) withStorage++;
        if (e.imageFiles.length) withImages++;
        if (e.p.parentId || e.p.ancestors.length) withParent++;
        if (e.p.version === null) versionZero++;
        if (!sample && e.html && e.html.length > 500) sample = e;
      }
    }
    ok(`export Confluence : ${dirs.length} pages dans ${dir}`);
    unreadable ? ko(`${unreadable} pages illisibles (metadata.json invalide ou sans pageId)`) : ok('toutes les pages sont lisibles');
    info(`${withStorage} pages avec page.storage.xml, ${withImages} avec images/, ${withParent} avec parent/ancêtres, ${versionZero} sans numéro de version`);
    if (sample) {
      const { parseViewPage } = require('../src/parse/confluence/viewHtml');
      const page = parseViewPage(sample.html, sample.p);
      info(
        `exemple "${sample.p.title}" : ${page.sections.length} sections, ${page.tables.length} tableaux, ${page.entities.ips.length} IP, ${page.entities.hosts.length} hôtes, ${page.diagrams.length} diagrammes, ${page.obsoleteFragments} passages barrés`
      );
    }
  });

  // 5. dossier de données
  await check('dossier de données', async () => {
    const { writeJsonAtomic, readJson } = require('../src/store/store');
    const probe = path.join(config.dataDir, `.doctor-${process.pid}.json`);
    writeJsonAtomic(probe, { ok: true });
    const back = readJson(probe, null);
    fs.unlinkSync(probe);
    if (!back || back.ok !== true) throw new Error('relecture incorrecte');
    const meta = path.join(config.dataDir, 'meta.json');
    ok(`données : ${config.dataDir} (${fs.existsSync(meta) ? 'graphe déjà construit' : 'vide, lancez npm run sync'})`);
  });

  // 6. frontend compilé
  const dist = path.join(config.frontendDist, 'index.html');
  fs.existsSync(dist)
    ? ok(`frontend compilé : ${config.frontendDist}`)
    : warn(`frontend non compilé (${config.frontendDist}) : npm run build sur une machine Node >= 20, puis copier frontend/dist`);

  // 7. passerelle IA
  if (noLlm) info('passerelle IA non testée (--no-llm)');
  else if (config.llm.mock) warn('LLM_MOCK actif : aucun appel réel');
  else if (!config.llm.token) ko('LLM_TOKEN vide dans backend/.env');
  else {
    info(`passerelle IA : ${config.llm.baseUrl} (jeton ${config.llm.token.slice(0, 4)}…)`);
    if (process.env.NODE_EXTRA_CA_CERTS) info(`certificat d'entreprise : NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}`);
    const { httpFetch } = require('../src/lib/httpFetch');
    await check('LLM /models', async () => {
      const t0 = Date.now();
      const res = await httpFetch(`${config.llm.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.llm.token}` }, timeoutMs: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const ids = ((await res.json()).data || []).map((m) => m.id);
      ok(`LLM joignable (${Date.now() - t0} ms), ${ids.length} modèles`);
      for (const [task, model] of Object.entries(config.llm.models)) {
        ids.includes(model) ? ok(`modèle ${task} = ${model}`) : warn(`modèle ${task} = ${model} absent de /models (vérifiez le nom exact)`);
      }
    });
    const { createLlmClient } = require('../src/lib/llmClient');
    const llm = createLlmClient({ ...config.llm, maxRetries: 0, cacheDir: null });
    for (const task of ['extract', 'chat']) {
      await check(`LLM chat (${task})`, async () => {
        const t0 = Date.now();
        const r = await llm.chatJson({ task, messages: [{ role: 'user', content: 'Réponds {"ok": true} en JSON.' }], maxTokens: 50 });
        r.ok === true ? ok(`chat JSON OK : ${config.llm.models[task]} (${Date.now() - t0} ms)`) : warn(`${config.llm.models[task]} répond mais JSON inattendu : ${JSON.stringify(r)}`);
      });
    }
    await check('LLM outils (function calling)', async () => {
      const tool = { type: 'function', function: { name: 'ping', description: 'Renvoie pong', parameters: { type: 'object', properties: {} } } };
      try {
        const r = await llm.chat({ task: 'chat', messages: [{ role: 'user', content: "Appelle l'outil ping." }], tools: [tool], maxTokens: 100, cache: false });
        r.toolCalls.length
          ? ok('outils (function calling) acceptés : LLM_TOOLS_MODE=native')
          : warn("outils acceptés mais non appelés par le modèle : si le chat répond mal, mettez LLM_TOOLS_MODE=json");
      } catch (err) {
        if (err.status === 400) warn(`la passerelle refuse les outils : mettez LLM_TOOLS_MODE=json dans backend/.env (${String(err.body || '').slice(0, 120)})`);
        else throw err;
      }
    });
  }
  return finish();
}

function finish() {
  console.log('\n--- Lyra doctor ---');
  for (const [lvl, msg] of results) console.log(`${lvl} ${msg}`);
  const errors = results.filter(([l]) => l === 'ERR ').length;
  console.log(`--- ${errors ? `${errors} erreur(s)` : 'aucune erreur'} ---\n`);
  process.exit(errors ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
