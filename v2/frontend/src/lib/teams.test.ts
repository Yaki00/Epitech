import { describe, expect, it } from 'vitest';
import type { AppOwner, Team, TeamApp } from './api';
import { criticalityTone, filterTeams, initials, orderTeams, sortOwners, sortTeamApps, tallySummary, teamCounts, teamTally, teamsHref } from './teams';
import { LINK_MARK_META, linkMark, pagePeriodKey } from './trust';

const app = (name: string, extra: Partial<TeamApp> = {}): TeamApp => ({
  id: `application:${name.toLowerCase()}`,
  name,
  criticality: null,
  role: 'owner',
  period: 'current',
  source: 'doc',
  docs: [],
  ...extra,
});
const team = (name: string, kind: Team['kind'], applications: TeamApp[]): Team => ({ id: kind === 'unassigned' ? null : `${kind}:${name}`, name, kind, applications });

describe('initials', () => {
  it('première et dernière lettre des mots, accents gardés', () => {
    expect(initials('Nadia Fontaine')).toBe('NF');
    expect(initials('Équipe Relation Client')).toBe('ÉC');
    expect(initials('anaïs')).toBe('A');
    expect(initials('Jean-Marc Dupont')).toBe('JD');
    expect(initials('  ')).toBe('?');
  });
});

describe('sortTeamApps', () => {
  it('actuelles d’abord, puis par rôle et nom ; anciennes et cibles à la fin', () => {
    const list = sortTeamApps([
      app('Zeta', { role: 'support' }),
      app('Old', { period: 'past' }),
      app('Beta', { role: 'owner' }),
      app('Next', { period: 'target', role: 'owner' }),
      app('Alpha', { role: 'oncall' }),
      app('Gamma', { role: 'owner', period: null }),
    ]);
    expect(list.map((a) => a.name)).toEqual(['Beta', 'Gamma', 'Zeta', 'Alpha', 'Next', 'Old']);
  });
});

describe('orderTeams', () => {
  const teams: Team[] = [
    team('', 'unassigned', [app('Borealis', { role: null, period: null, source: null })]),
    team('Hugo Rinaldi', 'person', [app('Sirius', { period: 'past' })]),
    team('Claire Vasseur', 'person', [app('Atlas')]),
    team('Équipe Finance', 'team', [app('Atlas', { role: 'support' }), app('Vega', { role: 'support' }), app('Altair', { role: 'support' })]),
    team('Anaïs Mercier', 'person', [app('Titan', { role: 'oncall' })]),
  ];

  it('le plus d’applications actuelles d’abord, anciens seulement ensuite, « Non renseignée » en dernier', () => {
    expect(orderTeams(teams).map((t) => t.name || t.kind)).toEqual(['Équipe Finance', 'Anaïs Mercier', 'Claire Vasseur', 'Hugo Rinaldi', 'unassigned']);
  });

  it('trie les applications de chaque carte et ne modifie pas l’entrée', () => {
    const out = orderTeams(teams);
    expect(out[0]!.applications.map((a) => a.name)).toEqual(['Altair', 'Atlas', 'Vega']);
    expect(teams[3]!.applications.map((a) => a.name)).toEqual(['Atlas', 'Vega', 'Altair']);
  });

  it('compte personnes, équipes et applications sans responsable', () => {
    expect(teamCounts(teams)).toEqual({ people: 3, teams: 1, unassigned: 1 });
  });

  it('filtre : nom de carte (carte entière) ou application (applications correspondantes seulement)', () => {
    expect(filterTeams(teams, 'finance').map((t) => [t.name, t.applications.length])).toEqual([['Équipe Finance', 3]]);
    const byApp = filterTeams(teams, 'ATLAS');
    expect(byApp.map((t) => t.name)).toEqual(['Claire Vasseur', 'Équipe Finance']);
    expect(byApp[1]!.applications.map((a) => a.name)).toEqual(['Atlas']);
    expect(filterTeams(teams, 'boreal').map((t) => t.kind)).toEqual(['unassigned']);
    expect(filterTeams(teams, 'anais').map((t) => t.name)).toEqual(['Anaïs Mercier']);
    expect(filterTeams(teams, '  ')).toHaveLength(teams.length);
    expect(filterTeams(teams, 'zzz')).toEqual([]);
  });
});

describe('sortOwners', () => {
  const o = (name: string, kind: AppOwner['kind'], role: AppOwner['role'], period: AppOwner['period'] = 'current'): AppOwner => ({ id: null, name, kind, role, period, source: 'doc', docs: [] });
  it('actuels d’abord, par rôle, équipes avant personnes à rôle égal', () => {
    const list = sortOwners([o('Hugo', 'person', 'owner', 'past'), o('Équipe Supply', 'team', 'support'), o('Inès', 'person', 'support'), o('Marc', 'person', 'owner')]);
    expect(list.map((x) => x.name)).toEqual(['Marc', 'Équipe Supply', 'Inès', 'Hugo']);
  });
});

describe('criticalityTone', () => {
  it('rouge, orange, jaune, gris', () => {
    expect(criticalityTone('Critique')).toBe('down');
    expect(criticalityTone('Haute')).toBe('crit');
    expect(criticalityTone('Moyenne')).toBe('warn');
    expect(criticalityTone('Basse')).toBe('unmon');
    expect(criticalityTone(null)).toBe('unmon');
  });
});

describe('teamsHref', () => {
  it('encode le nom', () => {
    expect(teamsHref('Équipe Finance')).toBe('/teams?q=%C3%89quipe%20Finance');
    expect(teamsHref(null)).toBe('/teams');
  });
});

describe('linkMark', () => {
  it('lien actif : aucune marque', () => {
    expect(linkMark({ retired: false, active: true, trust: 'added', period: 'current' })).toBeNull();
    expect(linkMark({ retired: false, inactive: false })).toBeNull();
    expect(linkMark({ retired: false })).toBeNull();
  });

  it('fiche application : retired vaut aussi pour un lien inactif, la marque l’emporte', () => {
    expect(linkMark({ retired: true, active: false, trust: 'toValidate', period: 'current' })).toBe('toValidate');
    expect(linkMark({ retired: true, active: false, trust: 'added', period: 'past' })).toBe('past');
    expect(linkMark({ retired: true, active: false, trust: null, period: 'target' })).toBe('target');
    expect(linkMark({ retired: true, active: false, trust: 'otherApp', period: 'current' })).toBe('otherApp');
    expect(linkMark({ retired: true, active: false, trust: null, period: null })).toBe('retired');
  });

  it('carte : lien inactif non retiré, ou retiré', () => {
    expect(linkMark({ retired: false, inactive: true, trust: 'toValidate', period: 'current' })).toBe('toValidate');
    expect(linkMark({ retired: false, inactive: true, trust: 'added', period: 'past' })).toBe('past');
    expect(linkMark({ retired: true, inactive: true, trust: null, period: null })).toBe('retired');
    // ancienne forme de l'API (sans marques)
    expect(linkMark({ retired: true })).toBe('retired');
  });

  it('libellés et tons', () => {
    expect(LINK_MARK_META.toValidate).toMatchObject({ labelKey: 'trust.toValidate', tone: 'warn' });
    expect(LINK_MARK_META.past.labelKey).toBe('trust.past');
    expect(LINK_MARK_META.target.labelKey).toBe('trust.target');
    expect(LINK_MARK_META.retired.labelKey).toBe('common.retired');
  });

  it('période d’une page : badge pour ancienne et cible seulement', () => {
    expect(pagePeriodKey('past')).toBe('appDetail.docs.period.past');
    expect(pagePeriodKey('target')).toBe('appDetail.docs.period.target');
    expect(pagePeriodKey('current')).toBeNull();
    expect(pagePeriodKey(null)).toBeNull();
  });
});

describe('teamTally et tallySummary', () => {
  it('ancien seulement : aucune application actuelle, « ancien responsable »', () => {
    const tally = teamTally({ applications: [app('Sirius', { period: 'past' })] });
    expect(tally).toEqual({ current: 0, past: 1, target: 0 });
    expect(tallySummary(tally)).toEqual({ kind: 'formerOnly' });
  });

  it('mélange : actuelles comptées à part des anciennes', () => {
    const tally = teamTally({ applications: [app('A'), app('B', { period: null }), app('C', { period: 'past' }), app('D', { period: 'target' })] });
    expect(tally).toEqual({ current: 2, past: 1, target: 1 });
    expect(tallySummary(tally)).toEqual({ kind: 'current', current: 2, past: 1 });
  });

  it('cible seulement : « responsable prévu » ; carte vide : zéro actuelle', () => {
    expect(tallySummary(teamTally({ applications: [app('N', { period: 'target' })] }))).toEqual({ kind: 'targetOnly' });
    expect(tallySummary(teamTally({ applications: [] }))).toEqual({ kind: 'current', current: 0, past: 0 });
  });
});
