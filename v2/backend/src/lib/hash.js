'use strict';
const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Hash stable d'un objet (clés triées) : sert de clé de cache. */
function stableHash(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => ((acc[k] = norm(v[k])), acc), {});
    }
    return v;
  };
  return sha256(JSON.stringify(norm(value)));
}

module.exports = { sha256, stableHash };
