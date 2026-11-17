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

const splitMulti = (v) =>
  String(v || '')
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * @param {object} repo
 * @param {object} p
 * @param {string} p.source   nom de la source (marketplace, apm…)
 * @param {Array<object>} p.records  lignes CSV (objets colonne -> valeur)
 * @param {object} p.mapping  { entity, key, name?, aliases?, attrs?, relations?, filter? }
 * @param {number} [p.runId]
 */
function ingestInventory(repo, { source, records, mapping, runId = null }) {
  const stats = { rows: records.length, nodes: 0, relations: 0, skipped: 0, errors: 0 };
  const missing = [mapping.key, ...(Object.values(mapping.attrs || {})), ...(mapping.relations || []).map((r) => r.column)].filter(
    (col) => records.length && !(col in records[0])
  );
  if (missing.length) throw new Error(`Colonnes absentes de l'export ${source} : ${missing.join(', ')}. Vérifiez config/mappings.json.`);

  repo.transaction(() => {
    records.forEach((row, i) => {
      const ref = `${source}#${i + 2}`; // n° de ligne Excel (en-tête = ligne 1)
      try {
        if (mapping.filter && Object.entries(mapping.filter).some(([col, val]) => String(row[col] ?? '') !== String(val))) {
          stats.skipped++;
          return;
        }
        const key = row[mapping.key];
        if (!key) {
          stats.skipped++;
          return;
        }
        const attrs = { [`${source}_row`]: i + 2 };
        for (const [attr, col] of Object.entries(mapping.attrs || {})) if (row[col] !== undefined && row[col] !== '') attrs[attr] = row[col];
        const aliases = (mapping.aliases || []).flatMap((col) => splitMulti(row[col]));
        const id = repo.upsertNode({ type: mapping.entity, key, name: row[mapping.name || mapping.key] || key, attrs, source, aliases });
        stats.nodes++;

        for (const rel of mapping.relations || []) {
          for (const value of rel.multi === false ? [row[rel.column]].filter(Boolean) : splitMulti(row[rel.column])) {
            const otherId = repo.upsertNode({ type: rel.entity, key: value, name: value, source });
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
  return stats;
}

module.exports = { ingestInventory, splitMulti, resolveInputFile };
