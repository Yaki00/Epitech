'use strict';
/**
 * Fichiers de configuration créés par `npm run setup` à partir des modèles, s'ils manquent (jamais
 * écrasés). Les consignes de lecture (backend/config/consignes-ia.md) n'en font pas partie : absentes,
 * l'analyse marche sans consigne ; on les écrit à partir de consignes-ia.example.md.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_COPIES = [
  ['backend/.env.example', 'backend/.env'],
  ['backend/config/mappings.example.json', 'backend/config/mappings.json'],
  ['backend/config/perimeter.example.json', 'backend/config/perimeter.json'],
];

/** Copie les modèles manquants sous `root` (dossier v2) ; renvoie la liste des fichiers créés. */
function copyMissingConfig(root, log = () => {}) {
  const created = [];
  for (const [from, to] of CONFIG_COPIES) {
    const dst = path.join(root, ...to.split('/'));
    if (fs.existsSync(dst)) log(`${to} existe déjà (conservé)`);
    else {
      fs.copyFileSync(path.join(root, ...from.split('/')), dst);
      created.push(to);
      log(`${to} créé depuis ${path.basename(from)}`);
    }
  }
  return created;
}

module.exports = { CONFIG_COPIES, copyMissingConfig };
