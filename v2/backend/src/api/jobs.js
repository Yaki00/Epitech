'use strict';
/**
 * Lancement des synchronisations depuis l'interface (page Synchronisation).
 *
 * Chaque tâche enchaîne des scripts du dossier backend/scripts, dans un processus séparé :
 * le serveur reste disponible, et les scripts gardent leur verrou (une seule synchro à la fois,
 * y compris par rapport à une tâche planifiée). Le journal des dernières lignes est gardé en mémoire.
 */
const { spawn } = require('child_process');
const path = require('path');

const MAX_LINES = 400;

/** Tâches proposées dans l'interface : étapes = [script, ...arguments]. */
function jobDefinitions(env = process.env) {
  // CONFLUENCE_FETCH=false : l'export est écrit par la v1, la v2 le lit seulement
  const fetchOff = env.CONFLUENCE_FETCH !== undefined && env.CONFLUENCE_FETCH !== '' && !['1', 'true', 'yes'].includes(String(env.CONFLUENCE_FETCH).toLowerCase());
  const confluenceFetch = env.CONFLUENCE_BASE_URL && !fetchOff ? [['fetch-confluence.js']] : [];
  return {
    confluence: {
      label: 'Confluence',
      description: fetchOff
        ? "Lecture des pages de l'export existant par l'IA, puis mise à jour des résumés (récupération assurée par la v1, CONFLUENCE_FETCH=false)"
        : "Récupère les pages modifiées, lecture des pages par l'IA, puis mise à jour des résumés",
      steps: [...confluenceFetch, ['sync-confluence.js', '--llm'], ['summarize-apps.js']],
    },
    apm: { label: 'APM', description: "Télécharge l'export s'il a un lien, puis l'importe", steps: [['fetch-inventory.js', 'apm'], ['sync-inventory.js', 'apm']] },
    marketplace: {
      label: 'Marketplace',
      description: "Télécharge l'export (une fois par jour), puis l'importe",
      steps: [['fetch-inventory.js', 'marketplace'], ['sync-inventory.js', 'marketplace']],
    },
    all: { label: 'Tout relancer', description: 'Confluence, APM, marketplace, analyse et résumés, dans le bon ordre', steps: [['../../scripts/sync-all.js']] },
  };
}

/**
 * @param {object} p { scriptsDir, cwd, logger, spawnFn (tests), env }
 */
function createJobRunner({ scriptsDir, cwd, logger = null, spawnFn = spawn, env = process.env }) {
  const defs = jobDefinitions(env);
  let current = null; // { id, job, label, status, startedAt, finishedAt, steps: [{name, status, code}], lines: [] }
  let seq = 0;

  const push = (line) => {
    current.lines.push(line);
    if (current.lines.length > MAX_LINES) current.lines.splice(0, current.lines.length - MAX_LINES);
  };

  function runStep([script, ...args]) {
    return new Promise((resolve) => {
      const step = { name: [path.basename(script), ...args].join(' '), status: 'running', code: null };
      current.steps.push(step);
      push(`$ node ${step.name}`);
      const child = spawnFn(process.execPath, [path.join(scriptsDir, script), ...args], { cwd, env });
      let rest = '';
      const onData = (chunk) => {
        const text = rest + chunk.toString('utf8');
        const parts = text.split(/\r?\n/);
        rest = parts.pop();
        for (const l of parts) if (l.trim()) push(l);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => {
        push(`erreur au lancement : ${err.message}`);
        step.status = 'error';
        resolve(false);
      });
      child.on('close', (code) => {
        if (rest.trim()) push(rest);
        step.code = code;
        step.status = code === 0 ? 'success' : 'error';
        resolve(code === 0);
      });
    });
  }

  /** Démarre une tâche ; erreur si une autre tourne déjà. */
  function start(job) {
    const def = defs[job];
    if (!def) throw Object.assign(new Error(`tâche inconnue : ${job}`), { status: 400 });
    if (current && current.status === 'running') throw Object.assign(new Error(`« ${current.label} » est déjà en cours`), { status: 409 });
    current = { id: ++seq, job, label: def.label, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, steps: [], lines: [] };
    const run = current;
    logger?.info(`synchro lancée depuis l'interface : ${def.label}`);
    (async () => {
      let ok = true;
      // une étape en échec n'empêche pas les suivantes (comme sync:all) : elles travaillent sur les données déjà là
      for (const step of def.steps) ok = (await runStep(step)) && ok;
      run.status = ok ? 'success' : 'error';
      run.finishedAt = new Date().toISOString();
      logger?.info(`synchro ${def.label} terminée : ${run.status}`);
    })();
    return status();
  }

  function status() {
    return {
      jobs: Object.entries(defs).map(([id, d]) => ({ id, label: d.label, description: d.description })),
      current: current && { ...current, steps: current.steps.map((s) => ({ ...s })), lines: current.lines.slice(-150) },
    };
  }

  return { start, status };
}

module.exports = { createJobRunner, jobDefinitions };
