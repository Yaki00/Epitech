'use strict';
/** Fonction de relève (fetchRaw) d'après la configuration : thruk ou csv. La source mock vient avec le mode démo. */
const { fetchThruk } = require('./thruk');
const { readNaemonCsv } = require('./csvSource');

function createFetchRaw(config, { mapping = null, http } = {}) {
  const n = config.naemon || {};
  if (n.source === 'thruk') return () => fetchThruk(n, http ? { http } : {});
  if (n.source === 'csv') {
    return async () => {
      let m = mapping && mapping.naemon;
      if (!m && !n.csvFile) throw new Error('Naemon CSV : ni bloc "naemon" dans mappings.json, ni NAEMON_CSV_FILE');
      if (n.csvFile) m = Array.isArray(m) ? m.map((x, i) => (i === 0 ? { ...x, file: n.csvFile } : x)) : { ...(m || { kind: 'hosts' }), file: n.csvFile };
      return readNaemonCsv(config.root, m);
    };
  }
  throw new Error(`Source Naemon "${n.source}" : pas de relève à brancher`);
}

module.exports = { createFetchRaw };
