import { describe, expect, it } from 'vitest';
import type { SyncJobs, SyncRun } from './api';
import { STAT_KEYS, jobHelpKey, jobsToShow, lastRunBySource, launchBlocked, notReadPages, runEnded, runStats, runStatus, statKey } from './sync';
import { DICTIONARIES } from './i18n';

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

  it('chiffres de la lecture IA affichés, avec un libellé en français et en anglais', () => {
    const stats = { read: 3, reverified: 1, notRead: 0, links: 7, owners: 2, toValidate: 1, otherApp: 1, rejected: 4, evidenceMismatch: 2, retired: 1, skipped: 5 };
    expect(runStats(run(1, 'confluence+llm', { stats })).map(([k]) => k)).toEqual([
      'skipped',
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
    ]);
    for (const k of STAT_KEYS) {
      for (const dict of Object.values(DICTIONARIES)) expect(typeof (dict as Record<string, unknown>)[`sync.stat.${k}`]).toBe('string');
    }
  });

  it('pages non lues par l’IA : dernier passage Confluence seulement', () => {
    expect(notReadPages([])).toBe(0);
    expect(notReadPages([run(3, 'apm'), run(2, 'confluence', { stats: { notRead: 12 } }), run(1, 'confluence+llm', { stats: { notRead: 0 } })])).toBe(12);
    expect(notReadPages([run(3, 'confluence+llm', { stats: { notRead: 0, read: 4 } }), run(2, 'confluence', { stats: { notRead: 12 } })])).toBe(0);
  });
});
