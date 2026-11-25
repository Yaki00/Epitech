/**
 * Personnes et équipes de la palette Ctrl+K (/api/teams) : gardées 5 minutes, et oubliées dès qu'une
 * synchronisation se termine (les responsables changent avec les synchros).
 */
import type { Team } from './api';

export const TEAMS_TTL_MS = 5 * 60_000;

let cache: { list: Team[]; at: number } | null = null;
let loading: Promise<Team[]> | null = null;
let generation = 0;

/** Liste gardée si elle a moins de 5 minutes, sinon null. */
export function cachedTeams(now = Date.now()): Team[] | null {
  return cache && now - cache.at < TEAMS_TTL_MS ? cache.list : null;
}

/** Oublie la liste gardée (fin d'une synchronisation) : la prochaine ouverture la recharge. */
export function invalidateTeamsCache(): void {
  cache = null;
  loading = null;
  generation += 1;
}

/** Charge la liste (sans le groupe « Non renseignée ») si elle n'est pas gardée ; un seul appel à la fois. */
export function loadTeams(fetchTeams: () => Promise<Team[]>, now: () => number = Date.now): Promise<Team[]> {
  const kept = cachedTeams(now());
  if (kept) return Promise.resolve(kept);
  if (loading) return loading;
  const gen = generation;
  const p = fetchTeams()
    .then((list) => {
      const people = list.filter((x) => x.kind !== 'unassigned' && x.name);
      if (gen === generation) cache = { list: people, at: now() };
      return people;
    })
    .finally(() => {
      if (loading === p) loading = null;
    });
  loading = p;
  return p;
}
