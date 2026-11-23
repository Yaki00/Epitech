'use strict';
/**
 * API REST consommée par le frontend.
 * createApp reçoit ses dépendances (repo, llm) : testable sans base réelle ni IA.
 */
const express = require('express');
const { impactOf, dependenciesOf, neighborhood } = require('../graph/impact');
const { ask } = require('../assistant/ask');
const views = require('./views');
const v2 = require('./views2');
const { writeGapsReport } = require('../naemon/gaps');
const path = require('path');
const fs = require('fs');

/**
 * @param {object} deps { repo, llm, logger, frontendDist, toolsMode, jobs, poller, history, config }
 *   jobs : lanceur de synchros (createJobRunner) ; absent = boutons de synchro désactivés
 *   poller : relève Naemon (snapshot()) ; absent = supervision désactivée (états « unknown », source « off »)
 *   history : historique des imports ; absent = aucun changement listé
 */
function createApp({ repo, llm, logger, frontendDist, toolsMode = 'native', jobs = null, poller = null, history = null, config = null }) {
  const d = { repo, poller, history, config, jobs };
  let version = null;
  try {
    version = require('../../../package.json').version || null;
  } catch (err) {
    version = null;
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    // CORS simple pour le front Vite en dev (localhost:3000 / 5173)
    res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // une synchro (autre processus) a pu réécrire les données : on recharge avant de répondre
  app.use('/api', (req, res, next) => {
    try {
      if (repo.reloadIfChanged && repo.reloadIfChanged()) logger?.info('données rechargées après une synchro');
    } catch (err) {
      logger?.warn('rechargement impossible, données précédentes conservées', { erreur: err.message });
    }
    next();
  });

  const intOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const floatOr = (v, d) => (v !== undefined && Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

  app.get('/api/health', (req, res) => res.json({ ok: true, counts: repo.countByType() }));

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    res.json(repo.search(q, intOr(req.query.limit, 20)));
  });

  app.get('/api/config', (req, res) => {
    const env = { ...process.env };
    if (!env.NAEMON_URL_TEMPLATE && config && config.naemon && config.naemon.urlTemplate) env.NAEMON_URL_TEMPLATE = config.naemon.urlTemplate;
    res.json(views.uiConfig(env, { demo: Boolean(config && config.demo), naemonSource: poller ? v2.snap(d).source : (config && config.naemon && config.naemon.source) || 'off', version }));
  });
  app.get('/api/applications', (req, res) => res.json(views.listApplications(repo, v2.ctxOf(d))));
  app.get('/api/applications/:id', (req, res) => {
    const r = views.applicationDetail(repo, req.params.id, v2.ctxOf(d));
    return r ? res.json(r) : res.status(404).json({ error: 'introuvable' });
  });
  app.get('/api/servers', (req, res) => res.json(views.searchServers(repo, req.query.q, intOr(req.query.limit, 30), v2.ctxOf(d))));

  // ---- API v2 ----
  app.get('/api/overview', (req, res) => res.json(v2.overviewView(d)));
  app.get('/api/status', (req, res) => res.json(v2.statusView(d)));
  app.get('/api/gaps', (req, res) => {
    const { gaps, raw } = v2.gapsView(d);
    if (req.query.format === 'csv') {
      const file = writeGapsReport((config && config.reportsDir) || require('os').tmpdir(), raw);
      return res.download(file, path.basename(file));
    }
    res.json(gaps);
  });
  app.get('/api/changes', (req, res) => res.json(v2.changesView(d, Math.min(Math.max(intOr(req.query.limit, 20), 1), 200))));
  app.get('/api/servers/:id', (req, res) => {
    const r = v2.serverDetail(d, req.params.id);
    return r ? res.json(r) : res.status(404).json({ error: 'introuvable' });
  });
  app.post('/api/simulate', (req, res) => {
    const ids = req.body && req.body.nodeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((x) => typeof x === 'string' && x)) {
      return res.status(400).json({ error: 'nodeIds : liste non vide de chaînes (500 au plus)' });
    }
    res.json(v2.simulate(d, [...new Set(ids)], { includeRetired: req.body.includeRetired === true, depth: Math.min(intOr(req.body.depth, 5), 8) }));
  });
  app.get('/api/map', (req, res) => {
    const scope = String(req.query.scope || 'perimeter');
    if (scope !== 'perimeter' && !/^app:.+/.test(scope)) return res.status(400).json({ error: 'scope : perimeter ou app:<id>' });
    const envs = req.query.envs ? String(req.query.envs).split(',') : null;
    const r = v2.mapView(d, { scope, envs, includeRetired: req.query.includeRetired === 'true' });
    return r ? res.json(r) : res.status(404).json({ error: 'introuvable' });
  });
  app.get('/api/teams', (req, res) => res.json(views.listTeams(repo)));

  app.get('/api/nodes/:id', (req, res) => {
    const node = repo.getNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'introuvable' });
    const label = (id) => repo.getNode(id)?.name || id;
    res.json({
      ...node,
      outgoing: repo.edgesFrom(node.id).map((e) => ({ ...e, dstName: label(e.dst) })),
      incoming: repo.edgesTo(node.id).map((e) => ({ ...e, srcName: label(e.src) })),
    });
  });

  const traversalOpts = (q) => ({ maxDepth: Math.min(intOr(q.depth, 4), 8), minConfidence: floatOr(q.minConfidence, 0.5) });

  app.get('/api/impact/:id', (req, res) => {
    const r = impactOf(repo, req.params.id, traversalOpts(req.query));
    return r ? res.json(r) : res.status(404).json({ error: 'introuvable' });
  });

  app.get('/api/dependencies/:id', (req, res) => {
    const r = dependenciesOf(repo, req.params.id, traversalOpts(req.query));
    return r ? res.json(r) : res.status(404).json({ error: 'introuvable' });
  });

  app.get('/api/graph/:id', (req, res) => {
    const r = neighborhood(repo, req.params.id, { depth: Math.min(intOr(req.query.depth, 2), 4) });
    return r ? res.json(r) : res.status(404).json({ error: 'introuvable' });
  });

  app.get('/api/sync/runs', (req, res) => res.json(repo.lastRuns(intOr(req.query.limit, 20))));
  // synchros lancées depuis l'interface
  app.get('/api/sync/jobs', (req, res) => res.json(jobs ? { enabled: true, ...jobs.status() } : { enabled: false, jobs: [], current: null }));
  app.post('/api/sync/jobs', (req, res) => {
    if (!jobs) return res.status(403).json({ error: 'Lancement depuis l\'interface désactivé (ALLOW_UI_SYNC=false dans backend/.env)' });
    try {
      res.status(202).json({ enabled: true, ...jobs.start(String(req.body?.job || '')) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  app.get('/api/sync/runs/:id/errors', (req, res) => res.json(repo.errorsOfRun(intOr(req.params.id, 0))));

  app.post('/api/ask', async (req, res) => {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question vide' });
    try {
      res.json(await ask({ llm, repo, question, history: req.body.history || [], toolsMode, lang: req.body.lang === 'en' ? 'en' : 'fr' }));
    } catch (err) {
      logger?.error('ask en échec', { erreur: err.message });
      res.status(502).json({ error: `IA indisponible : ${err.message}` });
    }
  });

  // En production, le backend sert aussi le front compilé (frontend/dist)
  const dist = frontendDist || path.resolve(__dirname, '../../../frontend/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // erreurs non gérées -> JSON propre
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger?.error('erreur API', { url: req.url, erreur: err.message });
    res.status(500).json({ error: err.message });
  });

  return app;
}

module.exports = { createApp };
