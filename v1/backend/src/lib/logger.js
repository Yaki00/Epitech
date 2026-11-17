'use strict';
/** Logger minimal, une ligne par événement, lisible et grep-able. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(scope, level = process.env.LOG_LEVEL || 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = (lvl, msg, data) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const extra = data === undefined ? '' : ' ' + JSON.stringify(data);
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line + extra);
  };
  return {
    debug: (m, d) => out('debug', m, d),
    info: (m, d) => out('info', m, d),
    warn: (m, d) => out('warn', m, d),
    error: (m, d) => out('error', m, d),
    child: (sub) => createLogger(`${scope}:${sub}`, level),
  };
}

module.exports = { createLogger };
