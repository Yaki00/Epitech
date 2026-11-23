#!/usr/bin/env node
'use strict';
/**
 * Installation : dépendances du backend (et du frontend si Node >= 20), puis fichiers de config
 * manquants créés à partir des exemples (n'écrase jamais l'existant).
 * Fonctionne sous Windows et Linux, sans dépendance.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { migrateFromV1 } = require('./lib/migrate');

const root = path.resolve(__dirname, '..');
const major = Number(process.versions.node.split('.')[0]);

function npmInstall(dir) {
  console.log(`\n> npm install dans ${dir}/`);
  const r = spawnSync('npm', ['install'], { cwd: path.join(root, dir), stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\n✖ npm install a échoué dans ${dir}/`);
    process.exit(r.status || 1);
  }
}

npmInstall('backend');
if (major >= 20) npmInstall('frontend');
else {
  console.log(`\nℹ Node ${process.versions.node} : le frontend (Vite 6) n'est pas installé ici, il demande Node >= 20.`);
  console.log('  Compilez-le sur une machine Node >= 20 (npm run build) puis copiez frontend/dist dans ce dossier.');
}

// Reprise de la v1 : si ../v1/backend/.env existe et que backend/.env n'existe pas encore,
// on reprend config, cache IA, store et CSV de la v1 (voir scripts/lib/migrate.js).
// Sans v1 à côté : copie des exemples ci-dessous, comme avant.
const v1Root = path.join(root, '..', 'v1');
if (fs.existsSync(path.join(v1Root, 'backend', '.env'))) {
  console.log('\n> Reprise de la v1 détectée');
  migrateFromV1({ v1Root, v2Root: root, log: (m) => console.log(`✔ ${m}`) });
}

const copies = [
  ['backend/.env.example', 'backend/.env'],
  ['backend/config/mappings.example.json', 'backend/config/mappings.json'],
  ['backend/config/perimeter.example.json', 'backend/config/perimeter.json'],
];
for (const [from, to] of copies) {
  const dst = path.join(root, to);
  if (fs.existsSync(dst)) console.log(`✔ ${to} existe déjà (conservé)`);
  else {
    fs.copyFileSync(path.join(root, from), dst);
    console.log(`✔ ${to} créé depuis ${path.basename(from)}`);
  }
}
console.log('\nÀ faire maintenant :');
console.log('  1. backend/.env : tout est commenté ; au minimum LLM_*, CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN, CONFLUENCE_SPACES');
console.log('     (clés des espaces : node backend/scripts/fetch-confluence.js --list-spaces)');
console.log('  2. backend/config/perimeter.json : les applications suivies (noms de la colonne A de l\'APM)');
console.log('  3. backend/config/mappings.json : fichiers CSV (APM, marketplace) et colonnes');
console.log('  4. npm run doctor   (vérifie tout, rapport à copier-coller)');
console.log('  5. npm run sync:all (récupère Confluence, importe les CSV, analyse ; voir README)');
console.log('  6. npm start\n');
