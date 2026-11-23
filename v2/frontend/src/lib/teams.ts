/**
 * Page Équipes et carte « Responsables » : tri, filtre et libellés (logique pure).
 * Les données viennent de /api/teams et de `owners` dans la fiche application.
 */
import type { AppOwner, OwnerRole, Team, TeamApp } from './api';
import type { Key } from './i18n';
import type { Tone } from './status';
import { criticalityRank } from './applications';
import { normalize } from './search';

/** Initiales d'un nom (deux au plus) : « Nadia Fontaine » donne « NF ». */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.']+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w));
  if (!words.length) return '?';
  const first = (w: string) => [...w][0]!.toUpperCase();
  return words.length === 1 ? first(words[0]!) : first(words[0]!) + first(words[words.length - 1]!);
}

const ROLE_ORDER: Record<OwnerRole, number> = { owner: 0, support: 1, oncall: 2, other: 3 };
const roleRank = (role: OwnerRole | null | undefined) => (role ? ROLE_ORDER[role] : 4);

export const ROLE_KEYS: Record<OwnerRole, Key> = {
  owner: 'teams.role.owner',
  support: 'teams.role.support',
  oncall: 'teams.role.oncall',
  other: 'teams.role.other',
};
export const roleKey = (role: OwnerRole | null | undefined): Key | null => (role ? (ROLE_KEYS[role] ?? ROLE_KEYS.other) : null);

/** Entrée actuelle (période absente comptée comme actuelle). */
export const isCurrent = (x: { period?: string | null }) => !x.period || x.period === 'current';

/** Applications d'une carte : actuelles d'abord (rôle puis nom), anciennes et cibles ensuite. */
export function sortTeamApps(apps: readonly TeamApp[]): TeamApp[] {
  return [...apps].sort(
    (a, b) => Number(!isCurrent(a)) - Number(!isCurrent(b)) || roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name),
  );
}

/** Responsables d'une application : actuels d'abord (rôle, puis équipes avant personnes, puis nom). */
export function sortOwners(owners: readonly AppOwner[]): AppOwner[] {
  return [...owners].sort(
    (a, b) =>
      Number(!isCurrent(a)) - Number(!isCurrent(b)) ||
      roleRank(a.role) - roleRank(b.role) ||
      Number(a.kind === 'person') - Number(b.kind === 'person') ||
      a.name.localeCompare(b.name),
  );
}

/** Nombre d'applications actuelles d'une carte. */
export const currentCount = (team: Team) => team.applications.filter(isCurrent).length;

export interface TeamTally {
  /** applications actuelles */
  current: number;
  /** applications lues dans une page ancienne */
  past: number;
  /** applications lues dans une page qui décrit une cible */
  target: number;
}

/** Compte des applications d'une carte par période. */
export function teamTally(team: Pick<Team, 'applications'>): TeamTally {
  const out: TeamTally = { current: 0, past: 0, target: 0 };
  for (const a of team.applications) {
    if (a.period === 'past') out.past += 1;
    else if (a.period === 'target') out.target += 1;
    else out.current += 1;
  }
  return out;
}

/**
 * Résumé du compte d'une carte (en-tête et palette) : nombre d'applications actuelles et anciennes, ou,
 * sans application actuelle, « ancien responsable » (seulement des anciennes) ou « responsable prévu » (cibles).
 */
export type TallySummary = { kind: 'current'; current: number; past: number } | { kind: 'formerOnly' } | { kind: 'targetOnly' };

export function tallySummary(t: TeamTally): TallySummary {
  if (t.current > 0) return { kind: 'current', current: t.current, past: t.past };
  if (t.past > 0) return { kind: 'formerOnly' };
  if (t.target > 0) return { kind: 'targetOnly' };
  return { kind: 'current', current: 0, past: 0 };
}

/**
 * Ordre des cartes : celles qui ont des applications actuelles d'abord (le plus d'applications, puis le nom),
 * les anciens seulement ensuite, le groupe « Non renseignée » toujours en dernier.
 * Les applications de chaque carte sont triées (`sortTeamApps`).
 */
export function orderTeams(teams: readonly Team[]): Team[] {
  const unassigned = teams.filter((t) => t.kind === 'unassigned');
  const others = teams
    .filter((t) => t.kind !== 'unassigned')
    .sort(
      (a, b) =>
        Number(currentCount(a) === 0) - Number(currentCount(b) === 0) ||
        currentCount(b) - currentCount(a) ||
        b.applications.length - a.applications.length ||
        a.name.localeCompare(b.name),
    );
  return [...others, ...unassigned].map((t) => ({ ...t, applications: sortTeamApps(t.applications) }));
}

/**
 * Filtre texte (casse et accents ignorés) : une carte dont le nom correspond est gardée entière ;
 * sinon on garde seulement ses applications qui correspondent (et la carte si au moins une reste).
 */
export function filterTeams(teams: readonly Team[], query: string): Team[] {
  const q = normalize(query);
  if (!q) return [...teams];
  const out: Team[] = [];
  for (const t of teams) {
    if (t.kind !== 'unassigned' && normalize(t.name).includes(q)) {
      out.push(t);
      continue;
    }
    const apps = t.applications.filter((a) => normalize(a.name).includes(q));
    if (apps.length) out.push({ ...t, applications: apps });
  }
  return out;
}

export interface TeamCounts {
  people: number;
  teams: number;
  /** applications sans responsable */
  unassigned: number;
}

export function teamCounts(teams: readonly Team[]): TeamCounts {
  return {
    people: teams.filter((t) => t.kind === 'person').length,
    teams: teams.filter((t) => t.kind === 'team').length,
    unassigned: teams.filter((t) => t.kind === 'unassigned').reduce((n, t) => n + t.applications.length, 0),
  };
}

/** Pastille de criticité : critique en rouge, haute en orange, moyenne en jaune, basse et inconnue en gris. */
export function criticalityTone(value: string | null | undefined): Tone {
  const r = criticalityRank(value);
  if (r >= 4) return 'down';
  if (r === 3) return 'crit';
  if (r === 2) return 'warn';
  return 'unmon';
}

/** Adresse de la page Équipes filtrée sur un nom (personne, équipe ou application). */
export const teamsHref = (name?: string | null): string => (name ? `/teams?q=${encodeURIComponent(name)}` : '/teams');
