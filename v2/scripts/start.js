#!/usr/bin/env node
'use strict';
/**
 * Lance Lyra. Si frontend/dist existe, le backend sert l'interface et l'API sur le même port (3002).
 * Sinon, sur une machine Node >= 20, lance aussi Vite en développement (:3000). Ctrl+C arrête tout. Fonctionne sous Windows, macOS et Linux, sans dépendance.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const major = Number(process.versions.node.split('.')[0]);
const hasDist = fs.existsSync(path.join(root, 'frontend', 'dist', 'index.html'));

// Avec un frontend compilé, le backend sert tout (interface + API) sur un seul port.
// Sans frontend compilé, on lance Vite en développement… seulement si Node >= 20 (Vite 6).
const services = [{ name: 'backend ', dir: 'backend', args: ['start'], color: '\x1b[36m' }];
if (!hasDist) {
  if (major >= 20 && fs.existsSync(path.join(root, 'frontend', 'node_modules'))) {
    services.push({ name: 'frontend', dir: 'frontend', args: ['run', 'dev'], color: '\x1b[35m' });
  } else {
    console.warn(
      `⚠ Interface non disponible : frontend/dist absent${major < 20 ? ` et Node ${process.versions.node} ne peut pas lancer Vite 6 (Node >= 20)` : ' et frontend non installé'}.\n` +
        '  Compilez le frontend sur une machine Node >= 20 (npm run build), copiez frontend/dist ici, puis relancez.\n' +
        "  L'API démarre quand même.\n"
    );
  }
}

if (!fs.existsSync(path.join(root, 'backend', 'node_modules'))) {
  console.error('\n✖ backend/node_modules absent : lancez d\'abord "npm run setup" à la racine de v2.\n');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'backend', '.env'))) {
  console.warn('⚠ backend/.env absent : lancez "npm run setup" puis renseignez LLM_TOKEN. Démarrage avec les valeurs par défaut.\n');
}

const children = services.map((s) => {
  // detached (hors Windows) : chaque service a son groupe de processus, qu'on arrête en entier
  const child = spawn('npm', s.args, { cwd: path.join(root, s.dir), shell: true, detached: process.platform !== 'win32', env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `${s.color}[${s.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}arrêté (code ${code})`);
    stopAll(code || 0);
  });
  return child;
});

const port = process.env.PORT || 3002;
console.log(
  hasDist
    ? `\n  Lyra démarre…  interface et API : http://localhost:${port}\n  Ctrl+C pour arrêter.\n`
    : `\n  Lyra démarre…  API : http://localhost:${port}${services.length > 1 ? '   front (dev) : http://localhost:3000' : ''}\n  Ctrl+C pour tout arrêter.\n`
);

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true });
    else {
      try {
        process.kill(-c.pid, 'SIGTERM'); // tout le groupe : npm + node/vite
      } catch {
        c.kill('SIGTERM');
      }
    }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
