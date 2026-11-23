'use strict';
/**
 * Reprise de la v1 par `npm run setup` (conception : « Reprise de la v1 »).
 * Sans dépendance (Node 16, Windows et Linux) : chemins par path.join, copies par fs, aucun shell.
 * N'écrase jamais un fichier existant ; ne modifie jamais la v1.
 */
const fs = require('fs');
const path = require('path');

const BLOCK_MARKER = '# --- Lyra v2 ---';

/** Lecture minimale d'un .env (premier KEY=valeur actif de chaque clé, comme dotenv). */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in out) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Valeur écrite dans un .env : entre apostrophes seulement si un « # » la couperait (pas d'échappement). */
const envValue = (v) => (/[#]/.test(v) && !v.includes("'") ? `'${v}'` : v);

/** Copie récursive sans jamais écraser. Retourne le nombre de fichiers copiés. */
function copyTree(src, dst) {
  if (!fs.existsSync(src) || path.resolve(src) === path.resolve(dst)) return 0;
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    if (fs.existsSync(dst)) return 0;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return 1;
  }
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) n += copyTree(path.join(src, name), path.join(dst, name));
  return n;
}

const V2_VARIABLES = `# Variables propres à la v2 (voir backend/.env.example pour le détail)
# Nombre d'imports d'inventaire conservés dans l'historique
# HISTORY_KEEP=50
# Supervision Naemon : off (défaut), thruk (API REST), csv (export Thruk)
# NAEMON_SOURCE=off
# NAEMON_THRUK_URL=https://<naemon>/thruk
# NAEMON_TOKEN=
# NAEMON_USER=
# NAEMON_PASSWORD=
# NAEMON_CSV_FILE=./data/raw/naemon/hosts_*.csv
# NAEMON_POLL_MINUTES=5
`;

/**
 * @param {{v1Root:string, v2Root:string, log?:(m:string)=>void}} p  racines des deux versions
 * @returns {{actions:string[]}}  ce qui a été fait (déjà passé à `log`)
 */
function migrateFromV1({ v1Root, v2Root, log = () => {} }) {
  const actions = [];
  const say = (m) => {
    actions.push(m);
    log(m);
  };
  const v1b = path.join(v1Root, 'backend');
  const v2b = path.join(v2Root, 'backend');
  const v1EnvFile = path.join(v1b, '.env');
  const v2EnvFile = path.join(v2b, '.env');

  if (!fs.existsSync(v1EnvFile)) return { actions };
  if (fs.existsSync(v2EnvFile)) {
    say('backend/.env existe déjà : reprise de la v1 ignorée (rien n\'est écrasé)');
    return { actions };
  }

  const v1Text = fs.readFileSync(v1EnvFile, 'utf8');
  const v1 = parseEnv(v1Text);
  const fromV1 = (key, def) => path.resolve(v1b, v1[key] || def);

  // 1. config : périmètre et colonnes
  for (const f of ['perimeter.json', 'mappings.json']) {
    const n = copyTree(path.join(v1b, 'config', f), path.join(v2b, 'config', f));
    say(n ? `config/${f} copié depuis la v1` : `config/${f} : conservé (déjà présent ou absent de la v1)`);
  }

  // 4, 5. cache IA et store : copiés vers les équivalents v2 (un chemin absolu de la v1 ramène aux défauts v2)
  const overrides = {};
  const relocate = (key, def, label) => {
    const value = v1[key] || def;
    const dst = path.isAbsolute(value) ? path.resolve(v2b, def) : path.resolve(v2b, value);
    if (path.isAbsolute(value)) overrides[key] = def;
    const n = copyTree(fromV1(key, def), dst);
    say(`${label} : ${n} fichier(s) copié(s) vers ${dst}`);
  };
  relocate('LLM_CACHE_DIR', './data/cache/llm', 'cache IA');
  relocate('DATA_DIR', './data/store', 'store (DATA_DIR)');

  // 6. petits fichiers d'inventaire
  for (const sub of ['apm', 'marketplace']) {
    const n = copyTree(path.join(v1b, 'data', 'raw', sub), path.join(v2b, 'data', 'raw', sub));
    say(`data/raw/${sub} : ${n} fichier(s) copié(s)`);
  }

  // 2, 3, 7. .env : valeurs v2 en tête de bloc ; dotenv garde la PREMIÈRE occurrence d'une clé,
  // donc les lignes actives de la v1 pour ces clés sont mises en commentaire dans la copie.
  const exportDir = fromV1('CONFLUENCE_EXPORT_DIR', './data/raw/confluence');
  const values = { PORT: '3002', CONFLUENCE_EXPORT_DIR: exportDir, CONFLUENCE_FETCH: 'false', DEMO_MODE: 'false', ...overrides };
  const lines = v1Text.split(/\r?\n/).map((l) => {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
    return m && m[1] in values ? `# (v1, remplacé par le bloc Lyra v2) ${l.trim()}` : l;
  });
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const block = [
    '',
    BLOCK_MARKER,
    '# Ajouté par « npm run setup » à la reprise de la v1.',
    '# La v1 reste seule à récupérer Confluence : la v2 lit son export sans jamais le modifier.',
    ...Object.entries(values).map(([k, v]) => `${k}=${envValue(v)}`),
    '',
    V2_VARIABLES,
  ].join('\n');
  fs.mkdirSync(v2b, { recursive: true });
  // écrit en dernier : un .env présent signifie que la reprise est complète
  fs.writeFileSync(v2EnvFile, lines.join('\n') + '\n' + block, { flag: 'wx' });
  say('backend/.env créé depuis celui de la v1 (+ bloc Lyra v2)');
  say(`PORT=3002, DEMO_MODE=false, CONFLUENCE_FETCH=false, export Confluence lu dans ${exportDir}`);

  return { actions };
}

module.exports = { migrateFromV1, BLOCK_MARKER, parseEnv };
