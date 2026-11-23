'use strict';
/**
 * Relevé Naemon simulé pour le mode démo. Même forme que fetchThruk ({ fetchedAt, hosts, services }).
 * Une situation fixe (une application en panne, une dégradée, une maintenance, une alerte prise en charge)
 * plus une alerte tournante : à chaque relève, une alerte apparaît et la précédente disparaît.
 */
const { createRng } = require('./generate');
const { serverEnv } = require('../lib/environment');

const isRetired = (x) => Boolean(x && x.attrs && x.attrs.retired);
const SERVICES = [
  { description: 'Charge CPU', ok: 'OK - charge moyenne 0.4, 0.5, 0.6', warn: 'WARNING - charge moyenne 6.2, 5.8, 5.1' },
  { description: 'Mémoire', ok: 'OK - mémoire utilisée 48 %', warn: 'WARNING - mémoire utilisée 91 %' },
  { description: 'Espace disque /', ok: 'OK - 41 % utilisé', warn: 'WARNING - 88 % utilisé' },
];

function createMockNaemon(repo, { seed = 42, now = Date.now } = {}) {
  const rng = createRng(seed);
  const servers = repo
    .listByType('server')
    .filter((n) => !isRetired(n))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const prdOf = (app) => servers.filter((s) => serverEnv(s) === 'PRD' && repo.edgesTo(s.id).some((e) => e.type === 'runs_on' && e.src === `application:${app}`));

  // situation fixe
  const down = new Set(prdOf('sirius-stocks').map((s) => s.name));
  const maintenance = new Set(prdOf('orion-clients').slice(1, 2).map((s) => s.name));
  const ackWarn = prdOf('atlas-paiements').slice(1, 2).map((s) => s.name);
  const fixedWarn = new Set(ackWarn);
  // quelques alertes de fond (environ 5 % des serveurs), hors situation fixe
  const rest = servers.filter((s) => !down.has(s.name) && !maintenance.has(s.name) && !fixedWarn.has(s.name) && serverEnv(s) !== null);
  const shuffled = rest.map((s) => [rng(), s]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const background = new Set(shuffled.slice(0, 2).map((s) => s.name));
  // alerte tournante : une machine de la liste, différente à chaque relève
  const pool = shuffled.slice(2).filter((s) => serverEnv(s) !== 'DEV').map((s) => s.name);
  // deux machines non supervisées (écart visible dans la page Supervision)
  const unmonitored = new Set(servers.filter((s) => serverEnv(s) === null).map((s) => s.name));

  let counter = 0;
  function fetchRaw(tick) {
    const t = tick === undefined ? counter++ : tick;
    const nowMs = now();
    const sec = Math.floor(nowMs / 1000);
    const rotating = pool.length ? pool[t % pool.length] : null;
    const hosts = [];
    const services = [];
    servers.forEach((s, i) => {
      if (unmonitored.has(s.name)) return;
      const isDown = down.has(s.name);
      const maint = maintenance.has(s.name);
      const alertIdx = ackWarn.includes(s.name) ? 2 : s.name === rotating || background.has(s.name) ? (i + (s.name === rotating ? t : 0)) % 3 : -1;
      const group = repo
        .edgesTo(s.id)
        .filter((e) => e.type === 'runs_on')
        .map((e) => repo.getNode(e.src))
        .filter(Boolean)
        .map((a) => a.name);
      hosts.push({
        name: s.name,
        address: s.attrs.ip || '',
        state: isDown ? 1 : 0,
        output: isDown ? 'CRITICAL - hôte injoignable (100 % de paquets perdus)' : 'OK - temps de réponse 0.4 ms',
        lastCheck: sec - ((i * 7) % 240),
        groups: group,
        ack: false,
        downtime: maint,
      });
      if (isDown) return;
      SERVICES.forEach((svc, k) => {
        const warn = k === alertIdx;
        services.push({
          host: s.name,
          description: svc.description,
          state: warn ? 1 : 0,
          output: warn ? svc.warn : svc.ok,
          lastCheck: sec - ((i * 11 + k * 13) % 240),
          ack: warn && ackWarn.includes(s.name),
          downtime: maint,
        });
      });
    });
    // un hôte supervisé que les inventaires ne connaissent pas (écart visible dans la page Supervision)
    hosts.push({ name: 'srv-atp-prd9', address: '10.11.0.99', state: 0, output: 'OK - temps de réponse 0.6 ms', lastCheck: sec - 30, groups: ['Atlas Paiements'], ack: false, downtime: false });
    return { fetchedAt: new Date(nowMs).toISOString(), hosts, services };
  }

  return { fetchRaw };
}

module.exports = { createMockNaemon };
