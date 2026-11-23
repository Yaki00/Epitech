'use strict';
const config = require('./config');
const { openStore } = require('./store/store');
const { createRepo } = require('./store/repo');
const { createLlmClient } = require('./lib/llmClient');
const { createLogger } = require('./lib/logger');
const { createApp } = require('./api/app');
const { createJobRunner } = require('./api/jobs');
const { createHistory } = require('./history/history');
const { startNaemonPoller } = require('./naemon/setup');
const path = require('path');
const fs = require('fs');
const { configureEnvironmentsFromFile } = require('./lib/environment');

const log = createLogger('server');

configureEnvironmentsFromFile(config.inventory.mappingFile);

let repo;
let llm;
let jobs = null;
let poller = null; // relève Naemon (démo : source simulée ; production : thruk ou csv ; off : aucune)
let history = null; // historique des imports
let dataDir = config.dataDir;

if (config.demo) {
  const { createPoller } = require('./naemon/poller');
  const { generateDemo } = require('./demo/generate');
  const { createMockNaemon } = require('./demo/naemonMock');
  const { createChatMock } = require('./demo/chatMock');

  dataDir = config.demoDir;
  if (path.resolve(dataDir) === path.resolve(config.dataDir)) throw new Error('Mode démo : demoDir ne doit pas être DATA_DIR');
  // le dossier de démo est vidé puis régénéré à chaque démarrage
  fs.rmSync(dataDir, { recursive: true, force: true });
  repo = createRepo(openStore(dataDir));
  history = createHistory(dataDir, { keep: config.history.keep });
  const demo = generateDemo(repo, history, { seed: 42, now: Date.now(), dir: dataDir });
  repo.flush();

  // Naemon simulé : une relève par minute, l'état évolue à chaque fois
  const mock = createMockNaemon(repo, { seed: 42 });
  let tick = 0;
  poller = createPoller({
    cfg: { ...config.naemon, source: 'mock', pollMinutes: 1 },
    repo,
    matcher: demo.matcher,
    fetchRaw: async () => mock.fetchRaw(tick++),
    file: path.join(dataDir, 'naemon-status.json'),
  });
  poller.start();

  // assistant simulé, réponses marquées « [démo] » ; pas de cache disque ; pas de synchro depuis l'interface
  llm = createLlmClient({ ...config.llm, mock: true, cacheDir: '' }, { mockHandler: createChatMock(repo) });
  log.info('MODE DÉMO : données fictives régénérées, Naemon et assistant simulés, synchros désactivées');
} else {
  repo = createRepo(openStore(config.dataDir));
  llm = createLlmClient(config.llm);
  // boutons « Lancer » de la page Synchronisation (ALLOW_UI_SYNC=false pour les retirer)
  history = createHistory(config.dataDir, { keep: config.history.keep });
  poller = startNaemonPoller({ config, repo, logger: log });
  jobs = config.allowUiSync ? createJobRunner({ scriptsDir: path.join(config.root, 'scripts'), cwd: config.root, logger: log }) : null;
}

const app = createApp({ repo, llm, logger: log, frontendDist: config.frontendDist, toolsMode: config.llm.toolsMode, jobs, poller, history, config });

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  log.info(`Lyra API sur http://${shown}:${config.port}`, { donnees: dataDir, graphe: repo.countByType() });
});
server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE' ? `Le port ${config.port} est déjà utilisé (PORT dans backend/.env)` : err.message);
  process.exit(1);
});

// arrêt propre : la relève Naemon ne retient pas le processus
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (poller) poller.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
