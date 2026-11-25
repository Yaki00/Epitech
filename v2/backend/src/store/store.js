'use strict';
/**
 * Stockage V1 : fichiers JSON dans DATA_DIR, chargés en mémoire (pas de base SQL).
 * Compatible Node 16, Windows et Linux, aucune dépendance.
 *
 *  - openStore(dir)        charge les fichiers (ou part de zéro) ; ':memory:' = sans fichier (tests)
 *  - store.flush()         écrit tout, de façon atomique (fichier temporaire puis rename)
 *  - store.reloadIfChanged()  recharge si un autre processus (synchro) a écrit depuis
 *  - acquireLock(dir)      un seul processus d'écriture (synchro) à la fois
 *
 * Seul store/repo.js utilise ce module. Pour passer à SQLite plus tard, on ne change que ces deux fichiers.
 *
 * Convention des liens : `src` DÉPEND DE `dst`
 *   app:alto --runs_on--> server:srv01  ⇒ si srv01 tombe, alto est impactée.
 */
const fs = require('fs');
const path = require('path');

const FILES = ['nodes', 'aliases', 'edges', 'documents', 'sync_runs', 'processing_errors'];
const META = 'meta.json';
const KEEP_RUNS = 200; // historique des synchros conservé

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Fichier de données illisible : ${file} (${err.message}). Supprimez DATA_DIR et relancez les synchros.`);
  }
}

/** Écrit dans un fichier temporaire puis renomme : jamais de fichier à moitié écrit. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows : antivirus / indexeur peuvent bloquer brièvement le fichier
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch (_) {
          /* rien */
        }
        throw err;
      }
      sleepSync(100 * (i + 1));
    }
  }
}

function emptyData() {
  return {
    nodes: new Map(), // id -> { id, type, name, attrs, createdAt, updatedAt }
    aliases: new Map(), // alias -> Map(nodeId -> source)
    edges: new Map(), // clé src|dst|type|source|sourceRef -> edge
    edgesBySrc: new Map(), // nodeId -> Set(clé)
    edgesByDst: new Map(),
    documents: new Map(), // id -> ligne document
    runs: [], // sync_runs
    errors: [], // processing_errors
    seq: { edge: 0, run: 0, error: 0 },
  };
}

const edgeKey = (e) => [e.src, e.dst, e.type, e.source, e.source_ref].join('|');

function indexEdge(data, key, e) {
  if (!data.edgesBySrc.has(e.src)) data.edgesBySrc.set(e.src, new Set());
  if (!data.edgesByDst.has(e.dst)) data.edgesByDst.set(e.dst, new Set());
  data.edgesBySrc.get(e.src).add(key);
  data.edgesByDst.get(e.dst).add(key);
}

function load(dir) {
  const data = emptyData();
  const meta = readJson(path.join(dir, META), null);
  if (!meta) return { data, version: null };
  const f = (name) => readJson(path.join(dir, `${name}.json`), []);
  for (const n of f('nodes')) data.nodes.set(n.id, n);
  for (const [alias, nodeId, source] of f('aliases')) {
    if (!data.aliases.has(alias)) data.aliases.set(alias, new Map());
    data.aliases.get(alias).set(nodeId, source);
  }
  for (const e of f('edges')) {
    const k = edgeKey(e);
    data.edges.set(k, e);
    indexEdge(data, k, e);
  }
  for (const d of f('documents')) data.documents.set(d.id, d);
  data.runs = f('sync_runs');
  data.errors = f('processing_errors');
  data.seq = { edge: 0, run: 0, error: 0, ...(meta.seq || {}) };
  return { data, version: meta.version || null };
}

function openStore(dir) {
  const memory = !dir || dir === ':memory:';
  let { data, version } = memory ? { data: emptyData(), version: null } : load(dir);
  const metaFile = memory ? null : path.join(dir, META);

  const store = {
    dir: memory ? null : dir,
    get data() {
      return data;
    },
    edgeKey,
    indexEdge: (k, e) => indexEdge(data, k, e),

    /** Écrit toutes les données. Le fichier meta.json est écrit en dernier : il marque une sauvegarde complète. */
    flush() {
      if (memory) return;
      // garde les KEEP_RUNS dernières synchros et leurs erreurs
      if (data.runs.length > KEEP_RUNS) {
        data.runs = data.runs.slice(-KEEP_RUNS);
        const keep = new Set(data.runs.map((r) => r.id));
        data.errors = data.errors.filter((e) => keep.has(e.run_id));
      }
      const aliasRows = [];
      for (const [alias, m] of data.aliases) for (const [nodeId, source] of m) aliasRows.push([alias, nodeId, source]);
      writeJsonAtomic(path.join(dir, 'nodes.json'), [...data.nodes.values()]);
      writeJsonAtomic(path.join(dir, 'aliases.json'), aliasRows);
      writeJsonAtomic(path.join(dir, 'edges.json'), [...data.edges.values()]);
      writeJsonAtomic(path.join(dir, 'documents.json'), [...data.documents.values()]);
      writeJsonAtomic(path.join(dir, 'sync_runs.json'), data.runs);
      writeJsonAtomic(path.join(dir, 'processing_errors.json'), data.errors);
      version = `${Date.now()}-${process.pid}`;
      writeJsonAtomic(metaFile, { version, savedAt: new Date().toISOString(), seq: data.seq, format: 1 });
    },

    /** Recharge si un autre processus a sauvegardé depuis le dernier chargement. Renvoie true si rechargé. */
    reloadIfChanged() {
      if (memory) return false;
      let meta;
      try {
        meta = readJson(metaFile, null);
      } catch (_) {
        return false; // écriture en cours : on garde la version en mémoire
      }
      if (!meta || meta.version === version) return false;
      ({ data, version } = load(dir));
      return true;
    },
  };
  return store;
}

/**
 * Verrou d'écriture : empêche deux synchros de tourner en même temps sur le même DATA_DIR.
 * @returns {() => void} fonction de libération
 */
function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.sync.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      alive = err.code === 'EPERM';
    }
    if (alive && pid !== process.pid) throw new Error(`Une synchro tourne déjà (pid ${pid}). Si ce n'est pas le cas, supprimez ${file}.`);
  }
  fs.writeFileSync(file, String(process.pid), 'utf8');
  return () => {
    try {
      fs.unlinkSync(file);
    } catch (_) {
      /* déjà supprimé */
    }
  };
}

module.exports = { openStore, acquireLock, writeJsonAtomic, readJson, FILES };
