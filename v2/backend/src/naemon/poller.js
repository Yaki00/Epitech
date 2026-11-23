'use strict';
/**
 * Relève périodique de Naemon. Le dernier état calculé est gardé en mémoire et dans un fichier
 * (relu au démarrage). Une erreur de relève ne détruit jamais l'état précédent : elle est exposée dans snapshot().
 * Rien n'est lu ni écrit sans que le fichier, la fonction de relève et l'horloge soient passés en paramètres.
 */
const fs = require('fs');
const { computeStatus } = require('./status');
const { readJson, writeJsonAtomic } = require('../store/store');

function createPoller({ cfg, repo, matcher = null, fetchRaw, file = null, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const periodMs = Math.max(1, Number(cfg.pollMinutes) || 5) * 60000;
  const state = { status: null, lastOk: null, lastError: null, nextAt: null };
  let timer = null;
  let running = null;

  if (file && fs.existsSync(file)) {
    try {
      const saved = readJson(file, null);
      if (saved && saved.status) {
        state.status = saved.status;
        state.lastOk = saved.lastOk || null;
      }
    } catch (err) {
      // fichier illisible : on repart sans état, la prochaine relève le réécrit
    }
  }

  const iso = (ms) => new Date(ms).toISOString();
  const schedule = () => {
    state.nextAt = timer === null ? null : iso(now() + periodMs);
  };

  async function run() {
    try {
      const raw = await fetchRaw();
      const m = typeof matcher === 'function' ? matcher() : matcher;
      state.status = computeStatus(repo, raw, { matcher: m });
      state.lastOk = iso(now());
      state.lastError = null;
      if (file) {
        try {
          writeJsonAtomic(file, { source: cfg.source, lastOk: state.lastOk, status: state.status });
        } catch (err) {
          state.lastError = `écriture de ${file} impossible : ${err.message}`;
        }
      }
    } catch (err) {
      state.lastError = err.message || String(err);
    }
    schedule();
  }

  /** Une relève à la fois : un appel pendant une relève en cours reprend la même. */
  function refresh() {
    if (!running) running = run().finally(() => (running = null));
    return running;
  }

  function start() {
    if (timer !== null) return Promise.resolve();
    timer = setIntervalFn(() => refresh(), periodMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return refresh();
  }

  function stop() {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    state.nextAt = null;
  }

  const snapshot = () => ({ status: state.status, source: cfg.source, lastOk: state.lastOk, lastError: state.lastError, nextAt: state.nextAt });

  return { start, stop, refresh, snapshot };
}

module.exports = { createPoller };
