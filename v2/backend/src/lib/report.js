'use strict';
/**
 * Rapports CSV à ouvrir dans Excel (séparateur ";" et BOM UTF-8 pour les accents).
 */
const fs = require('fs');
const path = require('path');

const cell = (v) => {
  const s = Array.isArray(v) ? v.join(' | ') : String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Écrit dir/name.csv et renvoie son chemin. */
function writeCsvReport(dir, name, headers, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.csv`);
  const lines = [headers, ...rows].map((r) => r.map(cell).join(';'));
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

module.exports = { writeCsvReport };
