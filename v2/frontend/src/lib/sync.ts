/**
 * Logique pure de la page Synchronisation : tâches connues, chiffres d'un passage, dernier passage par source,
 * raison pour laquelle les boutons de lancement sont coupés.
 */
import type { SyncJobs, SyncRun } from './api';
import type { Key } from './i18n';
import { sqlDate } from './applications';

/** Tâches lançables (ordre d'affichage) ; « all » est l'action principale. */
export const KNOWN_JOBS = ['all', 'confluence', 'apm', 'marketplace'] as const;
export type KnownJob = (typeof KNOWN_JOBS)[number];

export const isKnownJob = (id: string): id is KnownJob => (KNOWN_JOBS as readonly string[]).includes(id);

/**
 * Tâches à afficher : celles du serveur (ordre KNOWN_JOBS puis les autres), ou la liste connue quand le serveur
 * n'en propose aucune (lancement coupé) pour montrer ce qui existe, boutons désactivés.
 */
export function jobsToShow(jobs: SyncJobs | null): { id: string; label: string; description?: string }[] {
  const list = jobs?.jobs ?? [];
  if (!list.length) return KNOWN_JOBS.map((id) => ({ id, label: id }));
  const rank = (id: string) => (isKnownJob(id) ? KNOWN_JOBS.indexOf(id) : KNOWN_JOBS.length);
  return [...list].sort((a, b) => rank(a.id) - rank(b.id));
}

/** Récupération Confluence coupée (CONFLUENCE_FETCH=false : l'export est écrit par la v1). */
export const confluenceFetchOff = (description: string | undefined): boolean => /CONFLUENCE_FETCH=false/.test(description ?? '');

/** Clé du texte d'aide d'une tâche ; null pour une tâche inconnue (la description du serveur est alors affichée). */
export function jobHelpKey(job: { id: string; description?: string }): Key | null {
  if (job.id === 'confluence' && confluenceFetchOff(job.description)) return 'sync.job.confluence.helpNoFetch';
  return isKnownJob(job.id) ? (`sync.job.${job.id}.help` as Key) : null;
}

/** Pourquoi les boutons sont coupés : mode démo d'abord, puis lancement désactivé côté serveur. */
export function launchBlocked(demo: boolean, jobs: SyncJobs | null): 'demo' | 'disabled' | null {
  if (demo) return 'demo';
  if (jobs && !jobs.enabled) return 'disabled';
  return null;
}

/** Chiffres affichés pour un passage (ordre fixe ; seulement les nombres). */
export const STAT_KEYS = [
  'applications',
  'summarized',
  'unchanged',
  'withoutPages',
  'rows',
  'nodes',
  'relations',
  'pages',
  'skipped',
  'errors',
  'mentions',
  'diagramLinks',
  'llmRelations',
  'unresolved',
  'outOfScope',
  'inScope',
  'triaged',
  'llmDropped',
  'llmRenamed',
  'architecturePages',
  'read',
  'reverified',
  'notRead',
  'links',
  'owners',
  'toValidate',
  'otherApp',
  'rejected',
  'evidenceMismatch',
  'retired',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export function runStats(run: Pick<SyncRun, 'stats'>): [StatKey, number][] {
  const stats = run.stats ?? {};
  return STAT_KEYS.filter((k) => typeof stats[k] === 'number').map((k) => [k, stats[k] as number]);
}

/** Libellé d'un chiffre : pour un inventaire, « skipped » = lignes sans clé ; pour Confluence = pages inchangées. */
export function statKey(source: string, key: StatKey): Key {
  if (key === 'skipped' && !source.startsWith('confluence')) return 'sync.stat.skippedRows';
  return `sync.stat.${key}` as Key;
}

/** État d'affichage d'un passage ou d'une tâche (valeur inconnue = en cours). */
export type RunStatus = 'success' | 'partial' | 'error' | 'running' | 'skipped';
export const runStatus = (status: string | null | undefined): RunStatus =>
  status === 'success' || status === 'partial' || status === 'error' || status === 'skipped' ? status : 'running';

/** Dernier passage de chaque source (les passages arrivent du plus récent au plus ancien). */
export function lastRunBySource(runs: readonly SyncRun[]): SyncRun[] {
  const seen = new Set<string>();
  const out: SyncRun[] = [];
  for (const r of runs) {
    if (seen.has(r.source)) continue;
    seen.add(r.source);
    out.push(r);
  }
  return out;
}

/** Dates des passages : format SQLite UTC vers ISO. */
export const runStarted = (r: Pick<SyncRun, 'started_at'>): string | null => sqlDate(r.started_at);
export const runEnded = (r: Pick<SyncRun, 'started_at' | 'finished_at'>): string | null => sqlDate(r.finished_at) ?? sqlDate(r.started_at);

/**
 * Pages non lues par l'IA au dernier passage Confluence (IA non configurée ou injoignable) : nombre à
 * signaler sur la page Synchronisation, 0 s'il n'y en a pas ou si aucun passage Confluence n'existe.
 */
export function notReadPages(runs: readonly SyncRun[]): number {
  const last = runs.find((r) => r.source.startsWith('confluence'));
  const n = last?.stats?.notRead;
  return typeof n === 'number' && n > 0 ? n : 0;
}
