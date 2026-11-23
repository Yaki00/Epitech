import { describe, expect, it } from 'vitest';
import type { ApplicationSummary, Change } from './api';
import {
  DEFAULT_APP_FILTERS,
  attrValue,
  auditInfo,
  sqlDate,
  changeCounts,
  changesTouching,
  criticalityOptions,
  criticalityRank,
  filterApplications,
  filtersFromParams,
  filtersToParams,
  hasActiveFilters,
  nodeLabel,
  parseLinkId,
} from './applications';

const app = (over: Partial<ApplicationSummary> & { id: string; name: string }): ApplicationSummary => ({
  inPerimeter: true,
  criticality: null,
  owner: null,
  supportTeam: null,
  description: null,
  summary: null,
  environments: ['PRD'],
  servers: 1,
  databases: 0,
  lastSync: null,
  retired: false,
  status: { state: 'ok', byEnv: {}, atRisk: null },
  docScore: { score: 50, parts: [] },
  ...over,
});

const APPS = [
  app({ id: 'application:a', name: 'Atlas Paiements', criticality: 'Critique', status: { state: 'degraded', byEnv: {}, atRisk: null } }),
  app({ id: 'application:h', name: 'Hélios Commandes', criticality: 'Haute', summary: 'Prise de commande', status: { state: 'ok', byEnv: {}, atRisk: { because: 'application:a', path: ['application:h', 'application:a'] } } }),
  app({ id: 'application:b', name: 'Borealis', criticality: 'Basse', inPerimeter: false }),
  app({ id: 'application:z', name: 'Zéphyr', retired: true }),
];

const names = (list: ApplicationSummary[]) => list.map((a) => a.name);

describe('criticité', () => {
  it('rang des niveaux connus, en français et en anglais', () => {
    expect(criticalityRank('Critique')).toBe(4);
    expect(criticalityRank('HIGH')).toBe(3);
    expect(criticalityRank('Moyenne')).toBe(2);
    expect(criticalityRank('basse')).toBe(1);
    expect(criticalityRank('C3')).toBe(0);
    expect(criticalityRank(null)).toBe(-1);
  });

  it('options triées de la plus haute à la plus basse, sans doublon', () => {
    expect(criticalityOptions([{ criticality: 'Basse' }, { criticality: 'Critique' }, { criticality: null }, { criticality: 'Basse' }, { criticality: 'C2' }])).toEqual([
      'Critique',
      'Basse',
      'C2',
    ]);
  });
});

describe('filtres de la liste', () => {
  it('par défaut : retirées masquées', () => {
    expect(names(filterApplications(APPS, DEFAULT_APP_FILTERS))).toEqual(['Atlas Paiements', 'Hélios Commandes', 'Borealis']);
    expect(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, retired: true })).toHaveLength(4);
  });

  it('texte sans casse ni accents, sur le nom et le résumé', () => {
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, q: 'helios' }))).toEqual(['Hélios Commandes']);
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, q: 'COMMANDE' }))).toEqual(['Hélios Commandes']);
  });

  it('état, à risque, criticité, périmètre', () => {
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, state: 'degraded' }))).toEqual(['Atlas Paiements']);
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, state: 'atRisk' }))).toEqual(['Hélios Commandes']);
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, criticality: 'Haute' }))).toEqual(['Hélios Commandes']);
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, criticality: 'none', retired: true }))).toEqual(['Zéphyr']);
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, perimeter: 'out' }))).toEqual(['Borealis']);
    expect(names(filterApplications(APPS, { ...DEFAULT_APP_FILTERS, perimeter: 'in' }))).toEqual(['Atlas Paiements', 'Hélios Commandes']);
  });

  it('aller-retour avec l’adresse ; valeurs inattendues ignorées', () => {
    const f = { q: 'atlas', state: 'down' as const, criticality: 'Haute', perimeter: 'in' as const, retired: true };
    expect(filtersFromParams(filtersToParams(f))).toEqual(f);
    expect(filtersToParams(DEFAULT_APP_FILTERS).toString()).toBe('');
    expect(hasActiveFilters(DEFAULT_APP_FILTERS)).toBe(false);
    expect(filtersFromParams(new URLSearchParams('state=bizarre&scope=x'))).toEqual(DEFAULT_APP_FILTERS);
  });
});

describe('historique d’une application', () => {
  const change: Change = {
    at: '2026-11-22T10:00:00Z',
    source: 'apm',
    added: ['server:s1', 'server:other', 'application:h|server:s1|runs_on|apm'],
    removed: ['application:x|server:s9|runs_on|apm'],
    changed: [
      { id: 'server:s1', attr: 'ram', before: '16 Go', after: '32 Go' },
      { id: 'server:other', attr: 'os', before: 'a', after: 'b' },
    ],
    labels: { 'server:s1': 'srv-1' },
  };

  it('ne garde que ce qui touche les nœuds donnés (nœuds et liens)', () => {
    const out = changesTouching([change], new Set(['application:h', 'server:s1']));
    expect(out).toHaveLength(1);
    expect(out[0]?.added).toEqual(['server:s1', 'application:h|server:s1|runs_on|apm']);
    expect(out[0]?.removed).toEqual([]);
    expect(out[0]?.changed.map((c) => c.id)).toEqual(['server:s1']);
  });

  it('changement sans rapport : retiré', () => {
    expect(changesTouching([change], new Set(['server:zzz']))).toEqual([]);
  });

  it('comptes, liens et libellés', () => {
    expect(changeCounts(change)).toEqual({ addedNodes: 2, removedNodes: 0, addedLinks: 1, removedLinks: 1, changed: 2 });
    expect(parseLinkId('application:h|server:s1|runs_on|apm')).toEqual({ src: 'application:h', dst: 'server:s1', type: 'runs_on', source: 'apm' });
    expect(parseLinkId('server:s1')).toBeNull();
    expect(nodeLabel('server:s1', change.labels)).toBe('srv-1');
    expect(nodeLabel('server:inconnu', change.labels)).toBe('inconnu');
    expect(attrValue(null)).toBeNull();
    expect(attrValue(8)).toBe('8');
  });
});

describe('divers', () => {
  it('date SQLite lue comme UTC', () => {
    expect(sqlDate('2026-11-22 11:30:44')).toBe('2026-11-22T11:30:44Z');
    expect(sqlDate('2026-11-22T11:30:44.000Z')).toBe('2026-11-22T11:30:44.000Z');
    expect(sqlDate(null)).toBeNull();
  });

  it('contrôle d’une page d’architecture', () => {
    expect(auditInfo(null)).toEqual({ ok: null, env: null, problems: [] });
    expect(auditInfo({ ok: false, environment: 'PRD', problems: [{ code: 'missing', n: 2 }, { code: 'noReference' }, 'bizarre'] })).toEqual({
      ok: false,
      env: 'PRD',
      problems: [
        { code: 'missing', n: 2 },
        { code: 'noReference', n: 1 },
      ],
    });
    expect(auditInfo({ problems: [] }).ok).toBe(true);
  });
});
