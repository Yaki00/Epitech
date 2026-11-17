'use strict';
const config = require('./config');
const { openStore } = require('./store/store');
const { createRepo } = require('./store/repo');
const { createLlmClient } = require('./lib/llmClient');
const { createLogger } = require('./lib/logger');
const { createApp } = require('./api/app');
const { createJobRunner } = require('./api/jobs');
const path = require('path');

const log = createLogger('server');
const repo = createRepo(openStore(config.dataDir));
const llm = createLlmClient(config.llm);
// boutons « Lancer » de la page Synchronisation (ALLOW_UI_SYNC=false pour les retirer)
const jobs = config.allowUiSync ? createJobRunner({ scriptsDir: path.join(config.root, 'scripts'), cwd: config.root, logger: log }) : null;
const app = createApp({ repo, llm, logger: log, frontendDist: config.frontendDist, toolsMode: config.llm.toolsMode, jobs });

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  log.info(`Lyra API sur http://${shown}:${config.port}`, { donnees: config.dataDir, graphe: repo.countByType() });
});
server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE' ? `Le port ${config.port} est déjà utilisé (PORT dans backend/.env)` : err.message);
  process.exit(1);
});
