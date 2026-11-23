import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from './api';
import { TEAMS_TTL_MS, cachedTeams, invalidateTeamsCache, loadTeams } from './teamsCache';

const team = (name: string, kind: Team['kind'] = 'person'): Team => ({ id: kind === 'unassigned' ? null : `${kind}:${name}`, name, kind, applications: [] });

describe('teamsCache', () => {
  beforeEach(() => invalidateTeamsCache());

  it('garde la liste 5 minutes, sans le groupe « Non renseignée »', async () => {
    let now = 1_000;
    const fetchTeams = vi.fn(async () => [team('Ada'), team('', 'unassigned')]);
    expect((await loadTeams(fetchTeams, () => now)).map((t) => t.name)).toEqual(['Ada']);
    await loadTeams(fetchTeams, () => now);
    expect(fetchTeams).toHaveBeenCalledTimes(1);
    now += TEAMS_TTL_MS - 1;
    expect(cachedTeams(now)).not.toBeNull();
    now += 1;
    expect(cachedTeams(now)).toBeNull();
    await loadTeams(fetchTeams, () => now);
    expect(fetchTeams).toHaveBeenCalledTimes(2);
  });

  it('oubliée à la fin d’une synchronisation', async () => {
    const fetchTeams = vi.fn(async () => [team('Ada')]);
    await loadTeams(fetchTeams);
    expect(cachedTeams()).not.toBeNull();
    invalidateTeamsCache();
    expect(cachedTeams()).toBeNull();
    await loadTeams(fetchTeams);
    expect(fetchTeams).toHaveBeenCalledTimes(2);
  });
});
