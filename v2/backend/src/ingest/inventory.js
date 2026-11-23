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
  // date d'un fichier : celle de son nom (export daté), sinon le jour de sa dernière modification (fichier téléchargé)
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  const files = fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => {
      const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      return { file: path.join(dir, f), date: dateIn(f) || dayOf(mtime), mtime };
    });
  if (!files.length) return null;
  files.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0) || b.mtime - a.mtime);
  return files[0].file;
}

const { columnIndex } = require('../lib/csv');
const { nodeKey } = require('../store/repo');

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
 * Ce que le fichier fournit, sur TOUTES ses lignes (avant le filtre du périmètre) : une ligne hors périmètre
 * garde son serveur en vie. Seul le filtre du mapping (lignes qui ne sont pas des entrées d'inventaire) s'applique.
 * Identité d'un lien : src|dst|type|source.
 */
function computeSeen(records, mapping, source, { matcher = null, perimeterCol = null, multiPerimeter = false } = {}) {
  const nodeIds = new Set();
  const edgeIds = new Set();
  const attrsById = {};
  for (const row of records) {
    if (mapping.filter && Object.entries(mapping.filter).some(([col, val]) => String(row[col] ?? '') !== String(val))) continue;
    const key = row[mapping.key];
    if (!key) continue;
    const k = nodeKey(mapping.entity, key);
    if (!k) continue;
    const id = `${mapping.entity}:${k}`;
    nodeIds.add(id);
    attrsById[id] = pickAttrs(row, mapping.attrs);
    for (const rel of mapping.relations) {
      let values = rel.multi === false ? [row[rel.column]].filter(Boolean) : splitMulti(row[rel.column]);
      // colonne du périmètre : les vrais liens portent le nom de référence (alias, orthographe proche)
      if (matcher && perimeterCol && rel.column === perimeterCol) {
        values = values.map((raw) => {
          const m = matcher.matchName(raw, { minScore: 0.95 });
          return m ? m.app.name : raw;
        });
      }
      for (const value of values) {
        const ok = nodeKey(rel.entity, value);
        if (!ok) continue;
        const otherId = `${rel.entity}:${ok}`;
        const [src, dst] = rel.direction === 'to' ? [id, otherId] : [otherId, id];
        if (src !== dst) edgeIds.add(`${src}|${dst}|${rel.type}|${source}`);
      }
    }
  }
  return { nodeIds: [...nodeIds], edgeIds: [...edgeIds], attrsById };
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
  const multiPerimeter = scoped && mapping.relations.some((r) => r.column === perimeterCol && r.multi !== false);
  const missing = [
    perimeterCol,
    mapping.key,
    mapping.name,
    ...mapping.aliases,
    ...Object.values(mapping.attrs),
    ...mapping.relations.flatMap((r) => [r.column, ...Object.values(r.attrs)]),
  ].filter((col) => col && records.length && !cols.includes(col));
  if (missing.length) throw new Error(`Colonnes absentes de l'export ${source} : ${[...new Set(missing)].join(', ')}. Vérifiez config/mappings.json.`);

  const seen = computeSeen(records, mapping, source, { matcher: scoped ? matcher : null, perimeterCol, multiPerimeter });
  stats.seen = seen;

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
          // une cellule peut lister plusieurs applications ("BRIEF;HERA") : on garde celles du périmètre
          const values = multiPerimeter ? splitMulti(row[perimeterCol]) : [row[perimeterCol]].filter(Boolean);
          const kept = [];
          for (const raw of values) {
            const m = matcher.matchName(raw, { minScore: 0.95 });
            if (m) {
              if (!kept.includes(m.app.name)) kept.push(m.app.name);
              continue;
            }
            const near = matcher.matchName(raw, { minScore: 0.6 });
            if (near) nearMisses.set(`${raw} -> ${near.app.name}`, (nearMisses.get(`${raw} -> ${near.app.name}`) || 0) + 1);
          }
          if (!kept.length) {
            stats.outOfScope++;
            return;
          }
          row = { ...row, [perimeterCol]: kept.join(';') };
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
