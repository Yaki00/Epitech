'use strict';
/**
 * Parseur CSV sans dépendance : guillemets, retours ligne dans les champs,
 * BOM UTF-8, détection auto du séparateur (; , tab) — les exports Excel FR
 * utilisent souvent ";".
 */
function detectDelimiter(firstLine) {
  const counts = { ';': 0, ',': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const c of firstLine) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && c in counts) counts[c]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

function parseCsv(text, { delimiter } = {}) {
  const src = text.replace(/^﻿/, '');
  const delim = delimiter || detectDelimiter(src.split(/\r?\n/, 1)[0] || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [], delimiter: delim };
  const headers = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, records, delimiter: delim };
}

module.exports = { parseCsv, detectDelimiter };
