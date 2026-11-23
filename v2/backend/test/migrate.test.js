'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const { migrateFromV1, BLOCK_MARKER } = require('../../scripts/lib/migrate');
const { jobDefinitions } = require('../src/api/jobs');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, 'utf8');

/** Fausse v1 + v2 côte à côte dans un dossier temporaire dont le nom contient espaces et accents. */
function makeTree({ withV1 = true, v1Env } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'Mes Données '));
  const v1Root = path.join(base, 'équipe v1');
  const v2Root = path.join(base, 'équipe v2');
  fs.mkdirSync(path.join(v2Root, 'backend', 'config'), { recursive: true });
  if (withV1) {
    const b = path.join(v1Root, 'backend');
    write(path.join(b, '.env'), v1Env ?? 'PORT=3001\nLLM_TOKEN=secret\nCONFLUENCE_EXPORT_DIR=./data/raw/confluence\nCONFLUENCE_SPACES=AAA,BBB');
    write(path.join(b, 'config', 'perimeter.json'), '{"applications":["Alpha"]}');
    write(path.join(b, 'config', 'mappings.json'), '{"apm":{}}');
    write(path.join(b, 'data', 'store', 'apps.json'), '[{"name":"Alpha"}]');
    write(path.join(b, 'data', 'store', 'sous dossier', 'x.json'), '{}');
    write(path.join(b, 'data', 'cache', 'llm', 'ab', 'cle.json'), '{"cached":true}');
    write(path.join(b, 'data', 'raw', 'apm', 'apm.csv'), 'a;b\n1;2\n');
    write(path.join(b, 'data', 'raw', 'marketplace', 'servers.csv'), 'h;e\n');
    write(path.join(b, 'data', 'raw', 'confluence', '1', 'page.html'), '<p>x</p>');
  }
  return { base, v1Root, v2Root, v2b: path.join(v2Root, 'backend'), v1b: path.join(v1Root, 'backend') };
}

describe('migrateFromV1', () => {
  test('reprise complète : config, cache, store, CSV, bloc v2 et valeurs effectives', () => {
    const t = makeTree();
    const logs = [];
    const { actions } = migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: (m) => logs.push(m) });
    assert.ok(actions.length >= 6);
    assert.deepEqual(logs, actions);

    assert.equal(read(path.join(t.v2b, 'config', 'perimeter.json')), '{"applications":["Alpha"]}');
    assert.equal(read(path.join(t.v2b, 'config', 'mappings.json')), '{"apm":{}}');
    assert.equal(read(path.join(t.v2b, 'data', 'store', 'apps.json')), '[{"name":"Alpha"}]');
    assert.ok(fs.existsSync(path.join(t.v2b, 'data', 'store', 'sous dossier', 'x.json')));
    assert.equal(read(path.join(t.v2b, 'data', 'cache', 'llm', 'ab', 'cle.json')), '{"cached":true}');
    assert.ok(fs.existsSync(path.join(t.v2b, 'data', 'raw', 'apm', 'apm.csv')));
    assert.ok(fs.existsSync(path.join(t.v2b, 'data', 'raw', 'marketplace', 'servers.csv')));
    // l'export Confluence n'est PAS copié : la v2 le lit en place
    assert.ok(!fs.existsSync(path.join(t.v2b, 'data', 'raw', 'confluence')));

    const env = read(path.join(t.v2b, '.env'));
    assert.equal(env.split(BLOCK_MARKER).length - 1, 1);
    assert.equal(BLOCK_MARKER, '# --- Lyra v2 ---');
    const eff = dotenv.parse(env);
    assert.equal(eff.PORT, '3002');
    assert.equal(eff.CONFLUENCE_EXPORT_DIR, path.join(t.v1b, 'data', 'raw', 'confluence'));
    assert.ok(path.isAbsolute(eff.CONFLUENCE_EXPORT_DIR));
    assert.equal(eff.CONFLUENCE_FETCH, 'false');
    assert.equal(eff.DEMO_MODE, 'false');
    assert.equal(eff.LLM_TOKEN, 'secret');
    assert.equal(eff.CONFLUENCE_SPACES, 'AAA,BBB');
    // v1 jamais modifiée
    assert.equal(read(path.join(t.v1b, '.env')).includes('Lyra v2'), false);
  });

  test('deuxième lancement : n\'écrase rien et n\'ajoute pas un second bloc', () => {
    const t = makeTree();
    migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    const envBefore = read(path.join(t.v2b, '.env'));
    write(path.join(t.v2b, 'config', 'perimeter.json'), '{"applications":["Modifié"]}');
    write(path.join(t.v2b, 'data', 'store', 'apps.json'), '[]');
    fs.rmSync(path.join(t.v2b, 'data', 'raw', 'apm', 'apm.csv'));
    write(path.join(t.v1b, 'data', 'store', 'apps.json'), '[{"name":"Nouveau v1"}]');

    const { actions } = migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    assert.equal(read(path.join(t.v2b, '.env')), envBefore);
    assert.equal(read(path.join(t.v2b, '.env')).split(BLOCK_MARKER).length - 1, 1);
    assert.equal(read(path.join(t.v2b, 'config', 'perimeter.json')), '{"applications":["Modifié"]}');
    assert.equal(read(path.join(t.v2b, 'data', 'store', 'apps.json')), '[]');
    assert.ok(actions.some((a) => /existe déjà/.test(a)));
  });

  test('un .env v2 déjà présent (sans bloc) n\'est jamais modifié', () => {
    const t = makeTree();
    write(path.join(t.v2b, '.env'), 'PORT=4000\n');
    migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    assert.equal(read(path.join(t.v2b, '.env')), 'PORT=4000\n');
    assert.ok(!fs.existsSync(path.join(t.v2b, 'config', 'perimeter.json')));
  });

  test('v1 absente : rien n\'est fait (setup copie alors les exemples)', () => {
    const t = makeTree({ withV1: false });
    const { actions } = migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    assert.deepEqual(actions, []);
    assert.ok(!fs.existsSync(path.join(t.v2b, '.env')));
    assert.ok(!fs.existsSync(path.join(t.v2b, 'data')));
  });

  test('DATA_DIR, LLM_CACHE_DIR et export de la v1 résolus depuis son .env (relatifs à v1/backend)', () => {
    const t = makeTree({
      v1Env: 'PORT=3001\nDATA_DIR=./donnees/magasin\nLLM_CACHE_DIR=./cache ia\nCONFLUENCE_EXPORT_DIR=../export confluence\n',
    });
    write(path.join(t.v1b, 'donnees', 'magasin', 'g.json'), '{"g":1}');
    write(path.join(t.v1b, 'cache ia', 'c.json'), '{"c":1}');
    fs.mkdirSync(path.join(t.v1Root, 'export confluence'), { recursive: true });
    migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    // le .env copié garde DATA_DIR / LLM_CACHE_DIR relatifs : la v2 les résout dans v2/backend
    assert.equal(read(path.join(t.v2b, 'donnees', 'magasin', 'g.json')), '{"g":1}');
    assert.equal(read(path.join(t.v2b, 'cache ia', 'c.json')), '{"c":1}');
    const eff = dotenv.parse(read(path.join(t.v2b, '.env')));
    assert.equal(eff.DATA_DIR, './donnees/magasin');
    assert.equal(eff.CONFLUENCE_EXPORT_DIR, path.join(t.v1Root, 'export confluence'));
  });

  test('DATA_DIR absolu dans la v1 : la v2 utilise son propre dossier (pas de partage en écriture)', () => {
    const abs = path.join(os.tmpdir(), 'lyra-v1-abs-store');
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'a.json'), '{}');
    const t = makeTree({ v1Env: `DATA_DIR=${abs}\n` });
    migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    const eff = dotenv.parse(read(path.join(t.v2b, '.env')));
    assert.equal(eff.DATA_DIR, './data/store');
    assert.ok(fs.existsSync(path.join(t.v2b, 'data', 'store', 'a.json')));
    fs.rmSync(abs, { recursive: true, force: true });
  });

  test('CONFLUENCE_FETCH=false : le job Confluence n\'a pas d\'étape de récupération et le dit', () => {
    const env = { CONFLUENCE_BASE_URL: 'https://x', CONFLUENCE_FETCH: 'false' };
    const def = jobDefinitions(env).confluence;
    assert.ok(!def.steps.some((s) => s[0] === 'fetch-confluence.js'));
    assert.match(def.description, /récupération assurée par la v1/);
    assert.equal(jobDefinitions({ CONFLUENCE_BASE_URL: 'https://x' }).confluence.steps[0][0], 'fetch-confluence.js');
  });

  test('clé en double dans le .env de la v1 : la dernière valeur est lue, comme dotenv', () => {
    const { parseEnv } = require('../../scripts/lib/migrate');
    const text = 'CONFLUENCE_EXPORT_DIR=./ancien\nPORT=3001\nCONFLUENCE_EXPORT_DIR=./actuel\n';
    assert.equal(parseEnv(text).CONFLUENCE_EXPORT_DIR, './actuel');
    assert.equal(parseEnv(text).CONFLUENCE_EXPORT_DIR, dotenv.parse(text).CONFLUENCE_EXPORT_DIR);
  });

  test('migrated vrai seulement après une vraie reprise ; verrou et .tmp du store non copiés', () => {
    const t = makeTree();
    write(path.join(t.v1b, 'data', 'store', '.sync.lock'), '123');
    write(path.join(t.v1b, 'data', 'store', 'g.json.tmp'), '{');
    const r = migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} });
    assert.equal(r.migrated, true);
    assert.ok(fs.existsSync(path.join(t.v2b, 'data', 'store', 'apps.json')));
    assert.ok(!fs.existsSync(path.join(t.v2b, 'data', 'store', '.sync.lock')));
    assert.ok(!fs.existsSync(path.join(t.v2b, 'data', 'store', 'g.json.tmp')));
    assert.ok(!migrateFromV1({ v1Root: t.v1Root, v2Root: t.v2Root, log: () => {} }).migrated);
  });
});
