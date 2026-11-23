import { describe, expect, it } from 'vitest';
import type { SyncJobs, SyncRun } from './api';
import { jobHelpKey, jobsToShow, lastRunBySource, launchBlocked, runEnded, runStats, runStatus, statKey } from './sync';

const run = (id: number, source: string, extra: Partial<SyncRun> = {}): SyncRun => ({
  id,
  source,
  started_at: '2026-11-22 11:30:44',
  finished_at: null,
  status: 'success',
  stats: {},
  error: null,
  ...extra,
});

describe('sync', () => {
  it('tâches : ordre connu, liste par défaut quand le serveur n’en propose aucune', () => {
    const jobs: SyncJobs = {
      enabled: true,
      current: null,
      jobs: [
        { id: 'apm', label: 'APM' },
        { id: 'autre', label: 'Autre' },
        { id: 'all', label: 'Tout' },
      ],
    };
    expect(jobsToShow(jobs).map((j) => j.id)).toEqual(['all', 'apm', 'autre']);
    expect(jobsToShow({ enabled: false, jobs: [], current: null }).map((j) => j.id)).toEqual(['all', 'confluence', 'apm', 'marketplace']);
    expect(jobsToShow(null)).toHaveLength(4);
  });

  it('aide de la tâche Confluence quand la récupération est assurée par la v1', () => {
    expect(jobHelpKey({ id: 'confluence', description: 'Analyse ... (récupération assurée par la v1, CONFLUENCE_FETCH=false)' })).toBe('sync.job.confluence.helpNoFetch');
    expect(jobHelpKey({ id: 'confluence', description: 'Récupère les pages modifiées' })).toBe('sync.job.confluence.help');
    expect(jobHelpKey({ id: 'all' })).toBe('sync.job.all.help');
    expect(jobHelpKey({ id: 'inconnue' })).toBeNull();
  });

  it('boutons coupés : démo d’abord, puis lancement désactivé', () => {
    expect(launchBlocked(true, { enabled: true, jobs: [], current: null })).toBe('demo');
    expect(launchBlocked(false, { enabled: false, jobs: [], current: null })).toBe('disabled');
    expect(launchBlocked(false, { enabled: true, jobs: [], current: null })).toBeNull();
    expect(launchBlocked(false, null)).toBeNull();
  });

  it('chiffres d’un passage et libellés', () => {
    expect(runStats(run(1, 'apm', { stats: { rows: 10, errors: 2, other: 5, nodes: 'x' } }))).toEqual([
      ['rows', 10],
      ['errors', 2],
    ]);
    expect(statKey('apm', 'skipped')).toBe('sync.stat.skippedRows');
    expect(statKey('confluence+llm', 'skipped')).toBe('sync.stat.skipped');
  });

  it('état, dernier passage par source et dates', () => {
    expect(runStatus('success')).toBe('success');
    expect(runStatus('bizarre')).toBe('running');
    expect(lastRunBySource([run(3, 'apm'), run(2, 'confluence'), run(1, 'apm')]).map((r) => r.id)).toEqual([3, 2]);
    expect(runEnded(run(1, 'apm'))).toBe('2026-11-22T11:30:44Z');
    expect(runEnded(run(1, 'apm', { finished_at: '2026-11-22 12:00:00' }))).toBe('2026-11-22T12:00:00Z');
  });
});
