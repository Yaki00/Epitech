import { describe, expect, it } from 'vitest';
import type { LiveStatus, OverviewAlert, ServerSummary } from './api';
import { alertRows, countByEnv, impactedApps, maintenanceRows, naemonErrorKind, naemonHealth } from './monitoring';

const live = (servers: LiveStatus['servers']): LiveStatus => ({
  source: 'thruk',
  fetchedAt: null,
  lastOk: null,
  lastError: null,
  nextAt: null,
  servers,
  apps: {},
  atRisk: {},
  unmatchedHosts: [],
});
const srvLive = (state: string, extra: Partial<LiveStatus['servers'][string]> = {}) => ({ state, ack: false, output: '', lastCheck: null, services: [], ...extra }) as LiveStatus['servers'][string];

describe('alertRows', () => {
  const alerts: OverviewAlert[] = [
    { serverId: 'server:b', name: 'b', state: 'warning', output: 'w', ack: false, apps: [] },
    { serverId: 'server:a', name: 'a', state: 'down', output: 'd', ack: false, apps: [{ id: 'application:x', name: 'X' }] },
    { serverId: 'server:c', name: 'c', state: 'critical', output: 'c', ack: true, apps: [] },
  ];

  it('complète avec la relève et l’environnement, non prises en charge puis gravité', () => {
    const rows = alertRows(alerts, live({ 'server:a': srvLive('down', { lastCheck: 1700000000, output: 'frais' }), 'server:b': srvLive('warning', { ack: true }) }), new Map([['server:a', 'PRD']]));
    expect(rows.map((r) => r.serverId)).toEqual(['server:a', 'server:c', 'server:b']);
    expect(rows[0]).toMatchObject({ env: 'PRD', lastCheck: 1700000000, output: 'frais', ack: false });
    // b pris en charge d'après la relève la plus récente ; c garde l'ack de l'aperçu
    expect(rows[2]).toMatchObject({ ack: true, env: null, lastCheck: null, output: 'w' });
    expect(rows[1]?.ack).toBe(true);
  });

  it('sans relève : valeurs de l’aperçu', () => {
    const rows = alertRows(alerts.slice(0, 1), null, new Map());
    expect(rows[0]).toMatchObject({ output: 'w', ack: false, lastCheck: null, env: null });
  });
});

describe('impactedApps', () => {
  it('garde les applications en panne ou dégradées, la plus grave d’abord', () => {
    const apps = [
      { id: '1', name: 'B', state: 'degraded' as const },
      { id: '2', name: 'A', state: 'ok' as const },
      { id: '3', name: 'C', state: 'down' as const },
      { id: '4', name: 'D', state: 'unknown' as const },
    ];
    expect(impactedApps(apps).map((a) => a.id)).toEqual(['3', '1']);
  });
});

describe('maintenanceRows', () => {
  const servers: ServerSummary[] = [
    { id: 'server:m', name: 'm', attrs: {}, env: 'PRD', retired: false, state: 'ok', applications: [{ id: 'application:x', name: 'X', criticality: null }, { id: 'application:out', name: 'Out', criticality: null }] },
    { id: 'server:n', name: 'n', attrs: {}, env: 'STG', retired: false, state: 'ok', applications: [{ id: 'application:out', name: 'Out', criticality: null }] },
    { id: 'server:r', name: 'r', attrs: {}, env: 'PRD', retired: true, state: 'ok', applications: [{ id: 'application:x', name: 'X', criticality: null }] },
  ];
  it('serveurs en maintenance qui hébergent une application suivie', () => {
    const l = live({ 'server:m': srvLive('maintenance', { output: 'arrêt planifié' }), 'server:n': srvLive('maintenance'), 'server:r': srvLive('maintenance') });
    expect(maintenanceRows(servers, l, new Set(['application:x']))).toEqual([{ id: 'server:m', name: 'm', env: 'PRD', output: 'arrêt planifié', apps: [{ id: 'application:x', name: 'X' }] }]);
    expect(maintenanceRows(servers, null, new Set(['application:x']))).toEqual([]);
  });
});

describe('countByEnv', () => {
  it('compte null dans « none »', () => {
    expect(countByEnv([{ env: 'PRD' }, { env: null }, { env: 'PRD' }])).toEqual({ PRD: 2, STG: 0, DEV: 0, none: 1 });
  });
});

describe('naemonHealth', () => {
  it('off, erreur, démo, en attente, à jour', () => {
    expect(naemonHealth(null)).toBe('off');
    expect(naemonHealth({ source: 'off', lastOk: null, lastError: null })).toBe('off');
    expect(naemonHealth({ source: 'thruk', lastOk: 'x', lastError: 'boom' })).toBe('error');
    expect(naemonHealth({ source: 'mock', lastOk: 'x', lastError: null })).toBe('demo');
    expect(naemonHealth({ source: 'thruk', lastOk: null, lastError: null })).toBe('pending');
    expect(naemonHealth({ source: 'csv', lastOk: 'x', lastError: null })).toBe('ok');
  });
});

describe('naemonErrorKind', () => {
  it('reconnaît les erreurs du serveur', () => {
    expect(naemonErrorKind(null)).toBeNull();
    expect(naemonErrorKind('Thruk HTTP 401 sur https://h/thruk/r/hosts (jeton ou identifiants refusés)')).toBe('auth');
    expect(naemonErrorKind('Thruk : page HTML reçue (connexion ?), vérifiez NAEMON_TOKEN')).toBe('html');
    expect(naemonErrorKind('unable to verify the first certificate')).toBe('certificate');
    expect(naemonErrorKind('Timeout après 30000 ms')).toBe('timeout');
    expect(naemonErrorKind('getaddrinfo ENOTFOUND naemon.example')).toBe('unreachable');
    expect(naemonErrorKind('connect ECONNREFUSED 10.0.0.1:443')).toBe('unreachable');
    expect(naemonErrorKind('Thruk HTTP 404 sur https://h/r/hosts')).toBe('notFound');
    expect(naemonErrorKind('Thruk HTTP 502 sur https://h/r/hosts')).toBe('serverError');
    expect(naemonErrorKind('Naemon CSV : aucun fichier ne correspond à x*.csv')).toBe('csv');
    expect(naemonErrorKind('NAEMON_THRUK_URL est vide')).toBe('config');
    expect(naemonErrorKind('écriture de /d/naemon-status.json impossible : EACCES')).toBe('write');
    expect(naemonErrorKind('quelque chose d’autre')).toBe('other');
  });
});
