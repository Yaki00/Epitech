'use strict';
/**
 * Consignes de lecture : fichier texte modifiable (config/consignes-ia.md) donné à l'IA à chaque
 * analyse (conventions de nommage, sens des environnements, vocabulaire maison, pages à ignorer).
 * Absent ou vide : texte vide, l'analyse fonctionne quand même. Le fichier n'est jamais créé
 * automatiquement : on l'écrit à partir du modèle consignes-ia.example.md.
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

/**
 * Consignes identiques au modèle (exemples fictifs non adaptés) : vrai si les deux fichiers existent et
 * ont le même texte (espaces de début et fin, fins de ligne et BOM ignorés).
 */
function sameAsExample(file, exampleFile) {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    } catch (_) {
      return null;
    }
  };
  const a = read(file);
  const b = read(exampleFile);
  return a !== null && b !== null && a !== '' && a === b;
}

module.exports = { loadConsignes, sameAsExample, MAX_CHARS };
