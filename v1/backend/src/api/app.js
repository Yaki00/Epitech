'use strict';
/**
 * API REST consommée par le frontend.
 * createApp reçoit ses dépendances (repo, llm) : testable sans base réelle ni IA.
 */
const express = require('express');
const { impactOf, dependenciesOf, neighborhood } = require('../graph/impact');
const { ask } = require('../assistant/ask');
const views = require('./views');
const path = require('path');
const fs = require('fs');

function createApp({ repo, llm, logger, frontendDist, toolsMode = 'native' }) {
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

  app.get('/api/config', (req, res) => res.json(views.uiConfig()));
  app.get('/api/applications', (req, res) => res.json(views.listApplications(repo)));
  app.get('/api/applications/:id', (req, res) => {
    const d = views.applicationDetail(repo, req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'introuvable' });
  });
  app.get('/api/servers', (req, res) => res.json(views.searchServers(repo, req.query.q, intOr(req.query.limit, 30))));
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
  app.get('/api/sync/runs/:id/errors', (req, res) => res.json(repo.errorsOfRun(intOr(req.params.id, 0))));

  app.post('/api/ask', async (req, res) => {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question vide' });
    try {
      res.json(await ask({ llm, repo, question, history: req.body.history || [], toolsMode }));
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
