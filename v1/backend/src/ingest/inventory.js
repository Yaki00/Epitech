'use strict';
/**
 * Ingestion générique d'un inventaire tabulaire (export marketplace, APM, Naemon…)
 * piloté par un fichier de correspondance de colonnes (config/mappings.json).
 * Aucune colonne n'est écrite en dur dans le code : si l'export change, on
 * modifie le mapping, pas le script.
 */
const fs = require('fs');
const path = require('path');

/**
 * Fichier d'entrée d'une source. Le motif peut contenir * (ex : "./data/raw/apm/apm_os_*.csv") :
 * on prend alors le plus récent, d'après la date dans le nom (20261110 ou 2026-11-10), sinon la date de modification.
 * @returns {string|null} chemin absolu, ou null si aucun fichier ne correspond
 */
function resolveInputFile(root, pattern) {
  const full = path.resolve(root, pattern);
  if (!full.includes('*')) return fs.existsSync(full) ? full : null;
  const dir = path.dirname(full);
  if (dir.includes('*') || !fs.existsSync(dir)) return null;
  const esc = path.basename(full).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${esc}$`, process.platform === 'win32' ? 'i' : '');
  const dateIn = (name) => {
    const m = name.match(/(20\d{2})-?(\d{2})-?(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}` : '';
  };
  const files = fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ file: path.join(dir, f), date: dateIn(f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
  if (!files.length) return null;
  files.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0) || b.mtime - a.mtime);
  return files[0].file;
}

const { columnIndex } = require('../lib/csv');

const splitMulti = (v) =>
  String(v || '')
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

// alias (IP, FQDN) : une liste d'IP peut aussi être séparée par des espaces
const splitAliases = (v) =>
  String(v || '')
    .split(/[,;|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Remplace les références de colonnes par lettre Excel ("A", "CK") par le nom d'en-tête réel.
 * Un nom d'en-tête existant reste prioritaire : "OS" désigne la colonne nommée OS si elle existe.
 * @returns {{ mapping: object, resolved: Array<{ref: string, header: string}> }}
 */
function resolveMapping(mapping, headers) {
  const resolved = [];
  const col = (ref) => {
    if (ref === undefined || ref === null || headers.includes(ref)) return ref;
    const i = columnIndex(ref);
    if (i < 0 || i >= headers.length) return ref; // laissé tel quel : signalé comme colonne absente
    if (!resolved.some((r) => r.ref === ref)) resolved.push({ ref, header: headers[i] });
    return headers[i];
  };
  const attrsOf = (a) => Object.fromEntries(Object.entries(a || {}).map(([k, c]) => [k, col(c)]));
  return {
    mapping: {
      ...mapping,
      key: col(mapping.key),
      name: col(mapping.name),
      aliases: (mapping.aliases || []).map(col),
      attrs: attrsOf(mapping.attrs),
      relations: (mapping.relations || []).map((r) => ({ ...r, column: col(r.column), attrs: attrsOf(r.attrs) })),
      filter: mapping.filter ? Object.fromEntries(Object.entries(mapping.filter).map(([c, v]) => [col(c), v])) : undefined,
    },
    resolved,
  };
}

/** Attributs non vides d'une ligne, d'après { attribut: colonne }. */
function pickAttrs(row, attrs) {
  const out = {};
  for (const [attr, col] of Object.entries(attrs || {})) if (row[col] !== undefined && row[col] !== '') out[attr] = row[col];
  return out;
}

/**
 * @param {object} repo
 * @param {object} p
 * @param {string} p.source   nom de la source (marketplace, apm…)
 * @param {Array<object>} p.records  lignes CSV (objets colonne -> valeur)
 * @param {Array<string>} [p.headers] en-têtes dans l'ordre du fichier (nécessaire pour les colonnes par lettre)
 * @param {object} p.mapping  { entity, key, name?, aliases?, attrs?, relations?, filter? }
 *   Les colonnes se désignent par leur nom exact ou par leur lettre Excel ("A", "CK").
 *   Une relation peut porter des attributs pour l'entité liée : { column, entity, type, direction, multi?, attrs? }.
 *   perimeterColumn (ex "A") : avec un périmètre, seules les lignes dont l'application en fait partie sont gardées,
 *   et le nom est remplacé par le nom de référence. Correspondance stricte (nom, alias, mots collés) :
 *   les noms proches mais différents sont listés dans stats.nearMisses pour vérification.
 * @param {object} [p.matcher] périmètre (createMatcher), optionnel
 * @param {number} [p.runId]
 */
function ingestInventory(repo, { source, records, headers, mapping: rawMapping, matcher = null, runId = null }) {
  const stats = { rows: records.length, nodes: 0, relations: 0, skipped: 0, errors: 0 };
  const scoped = Boolean(matcher && rawMapping.perimeterColumn);
  const nearMisses = new Map();
  if (scoped) stats.outOfScope = 0;
  const cols = headers || Object.keys(records[0] || {});
  const { mapping } = resolveMapping(rawMapping, cols);
  const perimeterCol = scoped ? resolveMapping({ key: rawMapping.perimeterColumn }, cols).mapping.key : null;
  const missing = [
    perimeterCol,
    mapping.key,
    mapping.name,
    ...mapping.aliases,
    ...Object.values(mapping.attrs),
    ...mapping.relations.flatMap((r) => [r.column, ...Object.values(r.attrs)]),
  ].filter((col) => col && records.length && !cols.includes(col));
  if (missing.length) throw new Error(`Colonnes absentes de l'export ${source} : ${[...new Set(missing)].join(', ')}. Vérifiez config/mappings.json.`);

  repo.transaction(() => {
    records.forEach((original, i) => {
      let row = original;
      const ref = `${source}#${i + 2}`; // n° de ligne Excel (en-tête = ligne 1)
      try {
        if (mapping.filter && Object.entries(mapping.filter).some(([col, val]) => String(row[col] ?? '') !== String(val))) {
          stats.skipped++;
          return;
        }
        if (scoped) {
          const raw = row[perimeterCol];
          const m = raw ? matcher.matchName(raw, { minScore: 0.95 }) : null;
          if (!m) {
            stats.outOfScope++;
            const near = raw ? matcher.matchName(raw, { minScore: 0.6 }) : null;
            if (near) nearMisses.set(`${raw} -> ${near.app.name}`, (nearMisses.get(`${raw} -> ${near.app.name}`) || 0) + 1);
            return;
          }
          row = { ...row, [perimeterCol]: m.app.name };
        }
        const key = row[mapping.key];
        if (!key) {
          stats.skipped++;
          return;
        }
        const attrs = { [`${source}_row`]: i + 2, ...pickAttrs(row, mapping.attrs) };
        const aliases = mapping.aliases.flatMap((col) => splitAliases(row[col]));
        const id = repo.upsertNode({ type: mapping.entity, key, name: row[mapping.name || mapping.key] || key, attrs, source, aliases });
        stats.nodes++;

        for (const rel of mapping.relations) {
          const relAttrs = pickAttrs(row, rel.attrs);
          for (const value of rel.multi === false ? [row[rel.column]].filter(Boolean) : splitMulti(row[rel.column])) {
            const otherId = repo.upsertNode({ type: rel.entity, key: value, name: value, attrs: relAttrs, source });
            // direction "from" : l'autre entité dépend de celle-ci (ex: application -> runs_on -> serveur)
            const [src, dst] = rel.direction === 'to' ? [id, otherId] : [otherId, id];
            repo.addEdge({ src, dst, type: rel.type, source, sourceRef: ref, confidence: 1 });
            stats.relations++;
          }
        }
      } catch (err) {
        stats.errors++;
        if (runId) repo.recordError(runId, { source, ref, step: 'ingest', message: err.message });
      }
    });
  });
  if (nearMisses.size) stats.nearMisses = [...nearMisses.entries()].map(([k, n]) => `${k} (${n} lignes)`);
  return stats;
}

module.exports = { ingestInventory, splitMulti, resolveInputFile, resolveMapping };
