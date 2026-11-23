'use strict';
/**
 * Relève de l'état Naemon depuis un export CSV de Thruk (une ligne par hôte ou par service).
 * Bloc `naemon` de config/mappings.json :
 *   { file, kind: 'hosts' | 'services', columns: { name, address, state, output, lastCheck, groups, ack, downtime } }
 * (pour un fichier de services : host, description, state, output, lastCheck, ack, downtime).
 * Une colonne se désigne par son en-tête ou sa lettre Excel. Une liste de deux blocs (hôtes, services) est acceptée.
 */
const fs = require('fs');
const { parseCsv, decodeText } = require('../lib/csv');
const { resolveInputFile, resolveMapping, splitMulti } = require('../ingest/inventory');

const HOST_STATES = { up: 0, down: 1, unreachable: 2 };
const SERVICE_STATES = { ok: 0, warning: 1, critical: 2, unknown: 3 };

function stateOf(value, table, fallback) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (v === '') return fallback;
  if (v in table) return table[v];
  return Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 3 ? Number(v) : fallback;
}

const flag = (v) => ['1', 'true', 'yes', 'oui', 'x', 'y'].includes(String(v == null ? '' : v).trim().toLowerCase()) || Number(v) > 0;

function epoch(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (Number.isFinite(Number(s))) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.round(t / 1000);
}

function readOne(root, mapping, raw) {
  const kind = mapping.kind === 'services' ? 'services' : 'hosts';
  const file = resolveInputFile(root, mapping.file);
  if (!file) throw new Error(`Naemon CSV : aucun fichier ne correspond à ${mapping.file}`);
  const { records, headers } = parseCsv(decodeText(fs.readFileSync(file)).text);
  const cols = resolveMapping({ attrs: mapping.columns || {} }, headers).mapping.attrs;
  const required = kind === 'hosts' ? ['name', 'state'] : ['host', 'description', 'state'];
  for (const k of required) {
    if (!cols[k] || !headers.includes(cols[k])) throw new Error(`Naemon CSV : colonne "${k}" introuvable (${cols[k] || 'non déclarée'}) dans ${file}`);
  }
  for (const [k, c] of Object.entries(cols)) if (c && !headers.includes(c)) throw new Error(`Naemon CSV : colonne "${k}" introuvable (${c}) dans ${file}`);
  const get = (row, k) => (cols[k] ? row[cols[k]] : '');
  for (const row of records) {
    if (kind === 'hosts') {
      const name = String(get(row, 'name')).trim();
      if (!name) continue;
      raw.hosts.push({ name, address: String(get(row, 'address')).trim(), state: stateOf(get(row, 'state'), HOST_STATES, 2), output: String(get(row, 'output')), lastCheck: epoch(get(row, 'lastCheck')), groups: splitMulti(get(row, 'groups')), ack: flag(get(row, 'ack')), downtime: flag(get(row, 'downtime')) });
    } else {
      const host = String(get(row, 'host')).trim();
      if (!host) continue;
      raw.services.push({ host, description: String(get(row, 'description')).trim(), state: stateOf(get(row, 'state'), SERVICE_STATES, 3), output: String(get(row, 'output')), lastCheck: epoch(get(row, 'lastCheck')), ack: flag(get(row, 'ack')), downtime: flag(get(row, 'downtime')) });
    }
  }
}

/**
 * @param {string} root dossier de référence des chemins relatifs (backend/)
 * @param {object|object[]} mapping bloc `naemon` de mappings.json
 * @returns {{fetchedAt: string, hosts: object[], services: object[]}}
 */
function readNaemonCsv(root, mapping, { now = Date.now } = {}) {
  const raw = { fetchedAt: new Date(now()).toISOString(), hosts: [], services: [] };
  for (const m of Array.isArray(mapping) ? mapping : [mapping]) readOne(root, m, raw);
  return raw;
}

module.exports = { readNaemonCsv };
