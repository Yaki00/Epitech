'use strict';
/** Limite le nombre de promesses en parallèle (équivalent de p-limit, sans dépendance). */
function createLimiter(concurrency = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backoff exponentiel avec jitter : 1s, 2s, 4s… (+/- 25 %). */
function backoffDelay(attempt, baseMs = 1000, maxMs = 30000) {
  const raw = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(raw * (0.75 + Math.random() * 0.5));
}

module.exports = { createLimiter, sleep, backoffDelay };
