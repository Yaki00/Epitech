'use strict';
/**
 * Extraction robuste de JSON depuis une réponse de LLM.
 * Remplace la regex gourmande /\{[\s\S]*\}/ qui prend du premier "{" au dernier "}"
 * et casse dès qu'il y a du texte ou plusieurs objets.
 */

/** Retourne le premier objet/tableau JSON équilibré trouvé dans `text`, ou null. */
function findBalancedJson(text) {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break; // ce départ ne donne pas du JSON valide, on essaie le suivant
          }
        }
      }
    }
  }
  return null;
}

/**
 * Parse la sortie d'un LLM :
 * 1. JSON direct, 2. bloc ```json```, 3. premier objet équilibré.
 * Lève une erreur explicite si rien n'est exploitable.
 */
function parseLlmJson(raw) {
  if (raw === null || raw === undefined) throw new Error('Réponse LLM vide');
  const text = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // modèles "thinking" (Qwen)
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    /* on continue */
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* on continue */
    }
  }
  const found = findBalancedJson(text);
  if (found !== null) return found;
  throw new Error(`JSON introuvable dans la réponse LLM : ${text.slice(0, 200)}`);
}

/**
 * Validation légère par schéma minimal (sans dépendance).
 * schema = { champ: 'string' | 'number' | 'boolean' | 'array' | 'object', 'champ?': ... }
 */
function validateShape(obj, schema) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') return ['la racine doit être un objet'];
  for (const [rawKey, type] of Object.entries(schema)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    const v = obj[key];
    if (v === undefined || v === null) {
      if (!optional) errors.push(`champ manquant : ${key}`);
      continue;
    }
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== type) errors.push(`${key} : attendu ${type}, reçu ${actual}`);
  }
  return errors;
}

module.exports = { parseLlmJson, findBalancedJson, validateShape };
