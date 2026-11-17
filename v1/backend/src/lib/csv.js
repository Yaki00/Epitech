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

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 88 -> "CK" (lettres de colonnes Excel). */
function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" -> 0, "CK" -> 88 ; -1 si ce n'est pas une lettre de colonne. */
function columnIndex(letters) {
  if (!/^[A-Z]{1,3}$/.test(String(letters))) return -1;
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
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
  // en-têtes vides ou en double : suffixe avec la lettre Excel, sinon une colonne en écraserait une autre
  const seen = new Set();
  const headers = nonEmpty[0].map((h, i) => {
    let name = h.trim() || `Colonne ${columnLetter(i)}`;
    if (seen.has(name)) name = `${name} (${columnLetter(i)})`;
    seen.add(name);
    return name;
  });
  const records = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, records, delimiter: delim };
}

module.exports = { parseCsv, detectDelimiter, columnLetter, columnIndex };
