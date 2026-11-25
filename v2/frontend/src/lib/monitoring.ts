/**
 * Logique pure de la page Supervision : lignes d'alertes (environnement, prise en charge, dernier contrôle),
 * applications touchées, serveurs en maintenance, explication de la dernière erreur de relève Naemon.
 */
import type { AppState, Env, LiveStatus, Overview, OverviewAlert, ServerState, ServerSummary } from './api';
import { bySeverity } from './status';

export interface AlertRow {
  serverId: string;
  name: string;
  state: OverviewAlert['state'];
  ack: boolean;
  output: string;
  /** epoch en secondes, null si inconnu */
  lastCheck: number | null;
  /** null : environnement non précisé (ou serveur absent de la liste) */
  env: Env | null;
  apps: OverviewAlert['apps'];
}

const ALERT_RANK: Record<OverviewAlert['state'], number> = { down: 3, critical: 2, warning: 1 };

/**
 * Alertes du périmètre (/api/overview) complétées par la relève partagée (prise en charge, message,
 * dernier contrôle) et l'environnement de chaque serveur. Tri : non prises en charge d'abord, puis gravité, puis nom.
 */
export function alertRows(alerts: readonly OverviewAlert[], live: LiveStatus | null, envById: ReadonlyMap<string, Env | null>): AlertRow[] {
  return alerts
    .map((a) => {
      const l = live?.servers[a.serverId];
      return {
        serverId: a.serverId,
        name: a.name,
        state: a.state,
        ack: l ? Boolean(l.ack) : a.ack,
        output: l?.output || a.output || '',
        lastCheck: typeof l?.lastCheck === 'number' ? l.lastCheck : null,
        env: envById.get(a.serverId) ?? null,
        apps: a.apps,
      };
    })
    .sort((a, b) => Number(a.ack) - Number(b.ack) || ALERT_RANK[b.state] - ALERT_RANK[a.state] || a.name.localeCompare(b.name));
}

/** Applications du périmètre en panne ou dégradées, la plus grave d'abord. */
export function impactedApps<T extends { id: string; name: string; state: AppState }>(apps: readonly T[]): T[] {
  return apps.filter((a) => a.state === 'down' || a.state === 'degraded').sort((a, b) => bySeverity(a.state, b.state) || a.name.localeCompare(b.name));
}

export interface MaintenanceRow {
  id: string;
  name: string;
  env: Env | null;
  output: string;
  apps: { id: string; name: string }[];
}

/**
 * Serveurs en maintenance planifiée qui hébergent une application suivie (pas une panne : aucun impact propagé).
 * `tracked` : ids des applications du périmètre.
 */
export function maintenanceRows(servers: readonly ServerSummary[], live: LiveStatus | null, tracked: ReadonlySet<string>): MaintenanceRow[] {
  if (!live) return [];
  const out: MaintenanceRow[] = [];
  for (const s of servers) {
    const l = live.servers[s.id];
    if (s.retired || !l || (l.state as ServerState) !== 'maintenance') continue;
    const apps = s.applications.filter((a) => tracked.has(a.id)).map((a) => ({ id: a.id, name: a.name }));
    if (!apps.length) continue;
    out.push({ id: s.id, name: s.name, env: s.env, output: l.output || '', apps });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Nombre d'éléments par environnement (pour les compteurs du filtre). */
export function countByEnv(rows: readonly { env: Env | null }[]): Record<Env | 'none', number> {
  const c = { PRD: 0, STG: 0, DEV: 0, none: 0 };
  for (const r of rows) c[r.env ?? 'none'] += 1;
  return c;
}

// ---------- état de la relève ----------

export type NaemonHealth = 'off' | 'demo' | 'error' | 'pending' | 'ok';

/** État de la relève Naemon à afficher (source, dernière erreur, dernier succès). */
export function naemonHealth(n: Pick<Overview['naemon'], 'source' | 'lastOk' | 'lastError'> | null, demo = false): NaemonHealth {
  if (!n || n.source === 'off') return 'off';
  if (n.lastError) return 'error';
  if (demo || n.source === 'mock') return 'demo';
  return n.lastOk ? 'ok' : 'pending';
}

/** Nature d'une erreur de relève, pour dire quoi vérifier (le message brut du serveur reste affiché). */
export type NaemonErrorKind = 'auth' | 'html' | 'certificate' | 'timeout' | 'unreachable' | 'notFound' | 'serverError' | 'csv' | 'config' | 'write' | 'other';

export function naemonErrorKind(message: string | null | undefined): NaemonErrorKind | null {
  if (!message) return null;
  const m = message;
  if (/page HTML/i.test(m)) return 'html';
  if (/HTTP 40[13]\b|identifiants refusés|jeton/i.test(m)) return 'auth';
  if (/certificat|certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(m)) return 'certificate';
  if (/timeout|ETIMEDOUT|délai/i.test(m)) return 'timeout';
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|socket hang up/i.test(m)) return 'unreachable';
  if (/HTTP 404\b/.test(m)) return 'notFound';
  if (/HTTP 5\d\d\b/.test(m)) return 'serverError';
  if (/Naemon CSV|NAEMON_CSV_FILE/i.test(m)) return 'csv';
  if (/NAEMON_THRUK_URL|URL invalide|pas de relève à brancher/i.test(m)) return 'config';
  if (/écriture de .* impossible/i.test(m)) return 'write';
  return 'other';
}
