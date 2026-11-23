'use strict';
/**
 * Consignes de lecture : fichier texte modifiable (config/consignes-ia.md) donné à l'IA à chaque
 * analyse (conventions de nommage, sens des environnements, vocabulaire maison, pages à ignorer).
 * Absent ou vide : texte vide, l'analyse fonctionne quand même.
 */
const fs = require('fs');
const crypto = require('crypto');

const MAX_CHARS = 8000;

function loadConsignes(file) {
  const empty = { text: '', hash: null, chars: 0, truncated: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return empty;
  }
  const full = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!full) return empty;
  const truncated = full.length > MAX_CHARS;
  const text = truncated ? full.slice(0, MAX_CHARS) : full;
  return { text, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16), chars: text.length, truncated };
}

module.exports = { loadConsignes, MAX_CHARS };
