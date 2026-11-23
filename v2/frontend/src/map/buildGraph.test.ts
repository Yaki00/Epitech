import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { MapData, MapNode } from '../lib/api';
import { BAND_ID, buildGraph, clusterId, envCounts, layoutInputOf, zoneOf, zoneOfNode } from './buildGraph';
import { computeLayout } from './layoutCore';
import { edgeLook } from './edges';
import { DEFAULT_ENVS } from '../lib/envFilter';

const app = (id: string, extra: Partial<MapNode> = {}): MapNode => ({ id, type: 'application', label: id, env: null, state: 'ok', criticality: null, retired: false, appIds: [], ...extra });
const srv = (id: string, env: MapNode['env'], apps: string[] = ['application:a']): MapNode => ({ id, type: 'server', label: id, env, state: 'ok', criticality: null, retired: false, appIds: apps });
const db = (id: string): MapNode => ({ id, type: 'database', label: id, env: null, state: null, criticality: null, retired: false, appIds: [] });

const MAP: MapData = {
  nodes: [
    app('application:a'),
    app('application:b'),
    db('database:d'),
    srv('server:p1', 'PRD'),
    srv('server:p2', 'PRD', ['application:b']),
    srv('server:s1', 'STG'),
    srv('server:d1', 'DEV'),
    srv('server:n1', null),
  ],
  edges: [
    { id: '1', source: 'application:a', target: 'server:p1', type: 'runs_on', retired: false },
    { id: '2', source: 'application:b', target: 'server:p2', type: 'runs_on', retired: false },
    { id: '3', source: 'application:a', target: 'server:s1', type: 'runs_on', retired: false },
    { id: '4', source: 'application:a', target: 'server:d1', type: 'runs_on', retired: false },
    { id: '5', source: 'application:a', target: 'server:n1', type: 'runs_on', retired: false },
    { id: '6', source: 'application:a', target: 'application:b', type: 'calls', retired: false },
    { id: '7', source: 'application:b', target: 'database:d', type: 'uses_db', retired: true },
  ],
};

const parentOf = (g: ReturnType<typeof buildGraph>, id: string) => g.nodes.find((n) => n.id === id)?.parentId;
const zoneIn = (g: ReturnType<typeof buildGraph>, id: string) => zoneOfNode(g, id);

describe('buildGraph', () => {
  it('aucun serveur DEV par défaut (PRD et STG)', () => {
    const g = buildGraph(MAP, { envs: DEFAULT_ENVS });
    expect(g.zones).toEqual(['zone-PRD', 'zone-STG', 'zone-NONE']);
    expect(g.nodes.some((n) => n.id === 'server:d1')).toBe(false);
    expect(g.nodes.some((n) => n.id === 'zone-DEV')).toBe(false);
    expect(g.edges.some((e) => e.target === 'server:d1')).toBe(false);
  });

  it('DEV coché : troisième zone, entre STG et « Non précisé »', () => {
    const g = buildGraph(MAP, { envs: ['PRD', 'STG', 'DEV'] });
    expect(g.zones).toEqual(['zone-PRD', 'zone-STG', 'zone-DEV', 'zone-NONE']);
    expect(zoneIn(g, 'server:d1')).toBe('zone-DEV');
  });

  it('serveur env:null dans zone-NONE', () => {
    const g = buildGraph(MAP, { envs: DEFAULT_ENVS });
    expect(zoneIn(g, 'server:n1')).toBe('zone-NONE');
    expect(zoneOf(null)).toBe('zone-NONE');
    expect(zoneOf('QUAL')).toBe('zone-NONE');
  });

  it('serveur PRD jamais dans zone-STG', () => {
    const g = buildGraph(MAP, { envs: ['PRD', 'STG', 'DEV'] });
    const inStg = g.nodes.filter((n) => n.type === 'server' && zoneIn(g, n.id) === 'zone-STG').map((n) => n.id);
    expect(inStg).toEqual(['server:s1']);
    expect(zoneIn(g, 'server:p1')).toBe('zone-PRD');
    expect(zoneIn(g, 'server:p2')).toBe('zone-PRD');
  });

  it('zone masquée : ses serveurs ne sont pas dessinés ailleurs', () => {
    const g = buildGraph(MAP, { envs: ['STG'] });
    expect(g.zones).toEqual(['zone-STG', 'zone-NONE']);
    expect(g.nodes.some((n) => n.id === 'server:p1')).toBe(false);
  });

  it('« Non précisé » : absente sans serveur sans environnement, ou décochée', () => {
    const without = { ...MAP, nodes: MAP.nodes.filter((n) => n.id !== 'server:n1') };
    expect(buildGraph(without, { envs: DEFAULT_ENVS }).zones).toEqual(['zone-PRD', 'zone-STG']);
    expect(buildGraph(MAP, { envs: DEFAULT_ENVS, unspecified: false }).zones).toEqual(['zone-PRD', 'zone-STG']);
  });

  it('applications et bases dans la bande « Applications »', () => {
    const g = buildGraph(MAP, { envs: DEFAULT_ENVS });
    expect(parentOf(g, 'application:a')).toBe(BAND_ID);
    expect(parentOf(g, 'database:d')).toBe(BAND_ID);
    // le parent précède ses enfants (exigence de React Flow)
    const idx = (id: string) => g.nodes.findIndex((n) => n.id === id);
    expect(idx(BAND_ID)).toBeLessThan(idx('application:a'));
    expect(idx('zone-PRD')).toBeLessThan(idx(clusterId('zone-PRD', 'application:a')));
    expect(idx(clusterId('zone-PRD', 'application:a'))).toBeLessThan(idx('server:p1'));
  });

  it('serveurs groupés par application dans chaque zone, un seul lien d’hébergement par groupe', () => {
    const map: MapData = {
      nodes: [app('application:a'), srv('server:x1', 'PRD'), srv('server:x2', 'PRD'), srv('server:x3', 'STG')],
      edges: ['server:x1', 'server:x2', 'server:x3'].map((s, i) => ({ id: String(i), source: 'application:a', target: s, type: 'runs_on' as const, retired: false })),
    };
    const g = buildGraph(map, { envs: DEFAULT_ENVS });
    expect(parentOf(g, 'server:x1')).toBe(clusterId('zone-PRD', 'application:a'));
    expect(parentOf(g, 'server:x2')).toBe(clusterId('zone-PRD', 'application:a'));
    expect(parentOf(g, 'server:x3')).toBe(clusterId('zone-STG', 'application:a'));
    const hosting = g.edges.filter((e) => e.data!.type === 'runs_on');
    expect(hosting.map((e) => [e.target, e.data!.count])).toEqual([
      [clusterId('zone-PRD', 'application:a'), 2],
      [clusterId('zone-STG', 'application:a'), 1],
    ]);
  });

  it('serveur partagé : groupe de sa première application, lien direct depuis l’autre', () => {
    const map: MapData = {
      nodes: [app('application:a'), app('application:b'), srv('server:x', 'PRD', ['application:a', 'application:b'])],
      edges: [
        { id: '1', source: 'application:b', target: 'server:x', type: 'runs_on', retired: false },
        { id: '2', source: 'application:a', target: 'server:x', type: 'runs_on', retired: false },
      ],
    };
    const g = buildGraph(map, { envs: DEFAULT_ENVS });
    expect(parentOf(g, 'server:x')).toBe(clusterId('zone-PRD', 'application:a'));
    expect(g.edges.some((e) => e.source === 'application:b' && e.target === 'server:x')).toBe(true);
    expect(g.edges.some((e) => e.source === 'application:a' && e.target === clusterId('zone-PRD', 'application:a'))).toBe(true);
  });

  it('états en direct et simulation ne changent pas la structure', () => {
    const base = buildGraph(MAP, { envs: DEFAULT_ENVS });
    const sim = buildGraph(MAP, {
      envs: DEFAULT_ENVS,
      states: { 'server:p1': 'down' },
      simulate: { selected: ['server:p1'], impacted: ['application:a', 'application:b'] },
    });
    expect(sim.structureKey).toBe(base.structureKey);
    const data = (id: string) => sim.nodes.find((n) => n.id === id)!.data as { sim?: string; state?: string };
    expect(data('server:p1')).toMatchObject({ sim: 'origin', state: 'down' });
    expect(data('application:b').sim).toBe('impacted');
    expect(data('server:s1').sim).toBe('dim');
    expect(sim.edges.find((e) => e.source === 'application:a' && e.target === clusterId('zone-PRD', 'application:a'))!.data!.hot).toBe(true);
    expect(sim.edges.find((e) => e.target === clusterId('zone-STG', 'application:a'))!.data!.dim).toBe(true);
    expect(buildGraph(MAP, { envs: ['PRD', 'STG', 'DEV'] }).structureKey).not.toBe(base.structureKey);
  });

  it('lien retiré gardé et marqué', () => {
    const g = buildGraph(MAP, { envs: DEFAULT_ENVS });
    expect(g.edges.find((e) => e.data!.type === 'uses_db')!.data!.retired).toBe(true);
  });

  it('compte les serveurs par environnement', () => {
    expect(envCounts(MAP)).toEqual({ PRD: 2, STG: 1, DEV: 1, none: 1 });
  });
});

describe('computeLayout', () => {
  it('bande au-dessus, PRD à gauche de STG, chaque serveur dans les limites de sa zone', async () => {
    const g = buildGraph(MAP, { envs: ['PRD', 'STG', 'DEV'] });
    const r = await computeLayout(layoutInputOf(g), new ELK());
    const band = r.sizes[BAND_ID];
    const prd = r.positions['zone-PRD'];
    const stg = r.positions['zone-STG'];
    const dev = r.positions['zone-DEV'];
    const none = r.positions['zone-NONE'];
    expect(prd.y).toBeGreaterThan(band.h);
    expect(prd.x + r.sizes['zone-PRD'].w).toBeLessThanOrEqual(stg.x);
    expect(stg.x).toBeLessThan(dev.x);
    expect(dev.x).toBeLessThan(none.x);
    // chaque élément (groupe ou serveur) tient dans son parent
    for (const n of g.nodes) {
      if (!n.parentId || n.parentId === BAND_ID) continue;
      const p = r.positions[n.id];
      const parent = r.sizes[n.parentId];
      const own = r.sizes[n.id] ?? { w: 144, h: 30 };
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + own.w).toBeLessThanOrEqual(parent.w);
      expect(p.y + own.h).toBeLessThanOrEqual(parent.h);
    }
    // l'appelant est au-dessus de l'appelé
    expect(r.positions['application:a'].y).toBeLessThan(r.positions['application:b'].y);
  });
});

describe('liens inactifs (anciens, cibles, à valider)', () => {
  const INACTIVE: MapData = {
    nodes: [app('application:a'), app('application:h'), srv('server:x', 'PRD', ['application:h', 'application:a'])],
    // « application:a » passe avant « application:h » par ordre alphabétique, mais son lien est à valider
    edges: [
      { id: '1', source: 'application:a', target: 'server:x', type: 'runs_on', retired: false, inactive: true, trust: 'toValidate', period: 'current' },
      { id: '2', source: 'application:h', target: 'server:x', type: 'runs_on', retired: false, inactive: false, trust: null, period: null },
      { id: '3', source: 'application:a', target: 'application:h', type: 'calls', retired: false, inactive: true, trust: 'added', period: 'past' },
    ],
  };

  it('un serveur est rangé sous l’application qui l’héberge par un lien actif', () => {
    const g = buildGraph(INACTIVE, { envs: DEFAULT_ENVS });
    expect(parentOf(g, 'server:x')).toBe(clusterId('zone-PRD', 'application:h'));
  });

  it('marque les liens : à valider, ancien ; actif sans marque', () => {
    const g = buildGraph(INACTIVE, { envs: DEFAULT_ENVS });
    const grouped = g.edges.find((e) => e.source === 'application:h' && e.target === clusterId('zone-PRD', 'application:h'));
    expect(grouped?.data?.mark).toBeNull();
    const toValidate = g.edges.find((e) => e.source === 'application:a' && e.target === 'server:x');
    expect(toValidate?.data?.mark).toBe('toValidate');
    const past = g.edges.find((e) => e.data?.type === 'calls');
    expect(past?.data?.mark).toBe('past');
  });

  it('serveur seulement cité par un lien inactif : groupe sans application, lien direct marqué', () => {
    const only: MapData = {
      nodes: [app('application:h'), srv('server:y', 'PRD', [])],
      edges: [{ id: '9', source: 'application:h', target: 'server:y', type: 'runs_on', retired: false, inactive: true, trust: 'toValidate', period: 'current' }],
    };
    const g = buildGraph(only, { envs: DEFAULT_ENVS });
    expect(parentOf(g, 'server:y')).toBe(clusterId('zone-PRD', null));
    const e = g.edges.find((x) => x.source === 'application:h');
    expect(e?.target).toBe('server:y');
    expect(e?.data?.mark).toBe('toValidate');
  });

  it('apparence : à valider en pointillés, ancien grisé, retiré en tirets', () => {
    expect(edgeLook({ type: 'runs_on', retired: false, mark: 'toValidate', env: 'PRD' })).toMatchObject({ stroke: 'var(--color-warn)', dash: '3 4' });
    const past = edgeLook({ type: 'calls', retired: false, mark: 'past' });
    expect(past.stroke).toBe('var(--color-unmon)');
    expect(past.opacity).toBeLessThan(0.5);
    expect(edgeLook({ type: 'calls', retired: true })).toMatchObject({ dash: '7 5' });
    expect(edgeLook({ type: 'calls', retired: false, mark: null }).stroke).toBe('var(--color-ink-2)');
  });
});
