/**
 * Graphe de la cartographie (sans positions) à partir de /api/map.
 *
 * - Une bande « Applications » (applications et bases) au-dessus des zones d'environnement.
 * - Zones côte à côte : PRD, STG, DEV (si coché), puis « Non précisé » (serveurs sans environnement).
 * - Un serveur n'apparaît que dans la zone de son environnement ; si cette zone est masquée, il n'est pas dessiné.
 * - Liens inactifs (avec « Afficher retirés, anciens et à valider ») : marqués (`mark`) pour être grisés ou en
 *   pointillés, toujours dessinés un par un ; seuls les liens actifs rangent un serveur dans le groupe d'une application.
 * - Les états et la simulation ne changent que les données des nœuds : la structure (et donc la disposition)
 *   ne dépend que de `structureKey`.
 */
import type { Edge, Node } from '@xyflow/react';
import type { Env, MapData, MapEdgeType, MapNode } from '../lib/api';
import { ENVS, type EnvKey } from '../lib/status';
import { linkMark, type LinkMark } from '../lib/trust';

export const BAND_ID = 'band-apps';
export type ZoneId = 'zone-PRD' | 'zone-STG' | 'zone-DEV' | 'zone-NONE';
export const ZONE_ORDER: { id: ZoneId; env: EnvKey }[] = [
  { id: 'zone-PRD', env: 'PRD' },
  { id: 'zone-STG', env: 'STG' },
  { id: 'zone-DEV', env: 'DEV' },
  { id: 'zone-NONE', env: 'none' },
];

/** Tailles des nœuds (px) : serveurs compacts, applications plus grandes. */
export const NODE_SIZE = {
  application: { w: 212, h: 64 },
  database: { w: 176, h: 40 },
  server: { w: 144, h: 30 },
} as const;

/** Rôle d'un nœud dans la simulation : origine de la panne, touché, ou hors impact (estompé). */
export type SimRole = 'origin' | 'impacted' | 'dim';

export interface SimulateHighlight {
  selected: readonly string[];
  impacted: readonly string[];
}

export interface BuildOptions {
  /** environnements affichés en zones (PRD et STG par défaut) */
  envs: readonly Env[];
  /** zone « Non précisé » (serveurs sans environnement) ; vrai par défaut */
  unspecified?: boolean;
  /** simulation en cours : nœuds choisis et nœuds touchés */
  simulate?: SimulateHighlight | null;
  /** hors simulation : nœud mis en avant (ses liens directs ressortent) */
  focus?: string | null;
  /** états en direct qui remplacent ceux de /api/map (id de nœud vers état) */
  states?: Readonly<Record<string, string | undefined>>;
}

export interface ItemData extends Record<string, unknown> {
  kind: MapNode['type'];
  node: MapNode;
  label: string;
  state: string | null;
  retired: boolean;
  sim?: SimRole;
  /** voisin direct du nœud mis en avant (hors simulation) */
  near?: boolean;
  /** un autre nœud est mis en avant et celui-ci n'est pas relié */
  faded?: boolean;
}

export interface ZoneData extends Record<string, unknown> {
  kind: 'zone';
  env: EnvKey;
  count: number;
}

/** Groupe de serveurs d'une même application dans une zone (un seul lien d'hébergement par groupe). */
export interface ClusterData extends Record<string, unknown> {
  kind: 'cluster';
  env: EnvKey;
  /** application principale (null : serveur sans application sur la carte) */
  appId: string | null;
  label: string;
  count: number;
  /** simulation : aucun serveur du groupe n'est touché */
  dim?: boolean;
  /** son application est mise en avant */
  near?: boolean;
}

export interface BandData extends Record<string, unknown> {
  kind: 'band';
  applications: number;
  databases: number;
}

export interface EdgeData extends Record<string, unknown> {
  type: MapEdgeType;
  retired: boolean;
  /** lien inactif : à valider, ancien, cible, autre application, retiré (null : actif) */
  mark?: LinkMark | null;
  /** runs_on : environnement du serveur (couleur du lien) */
  env?: EnvKey;
  /** lien d'hébergement regroupé : nombre de serveurs du groupe */
  count?: number;
  /** relie deux éléments touchés (ou choisis) par la simulation, ou le nœud mis en avant */
  hot?: boolean;
  dim?: boolean;
}

export type ItemNode = Node<ItemData, 'application' | 'server' | 'database'>;
export type ZoneNode = Node<ZoneData, 'zone'>;
export type ClusterNode = Node<ClusterData, 'cluster'>;
export type BandNode = Node<BandData, 'band'>;
export type MapFlowNode = ItemNode | ZoneNode | ClusterNode | BandNode;
export type MapFlowEdge = Edge<EdgeData, 'lyra'>;

export interface MapGraph {
  nodes: MapFlowNode[];
  edges: MapFlowEdge[];
  /** zones affichées, dans l'ordre (PRD à gauche) */
  zones: ZoneId[];
  /** identifiant de la structure : la disposition n'est recalculée que s'il change */
  structureKey: string;
}

/** Zone d'un serveur selon son environnement (absent ou inattendu : « Non précisé »). */
export function zoneOf(env: string | null | undefined): ZoneId {
  return env === 'PRD' || env === 'STG' || env === 'DEV' ? (`zone-${env}` as ZoneId) : 'zone-NONE';
}

/** Zones à dessiner : environnements cochés (même vides), « Non précisé » seulement s'il a des serveurs. */
export function visibleZones(map: MapData, envs: readonly Env[], unspecified = true): ZoneId[] {
  const hasNone = map.nodes.some((n) => n.type === 'server' && zoneOf(n.env) === 'zone-NONE');
  return ZONE_ORDER.filter((z) => (z.env === 'none' ? unspecified && hasNone : ENVS.includes(z.env as Env) && envs.includes(z.env as Env))).map((z) => z.id);
}

/** Nombre de serveurs par environnement (pour le filtre). */
export function envCounts(map: MapData | null | undefined): Record<EnvKey, number> {
  const c: Record<EnvKey, number> = { PRD: 0, STG: 0, DEV: 0, none: 0 };
  for (const n of map?.nodes ?? []) if (n.type === 'server') c[zoneOf(n.env) === 'zone-NONE' ? 'none' : (n.env as Env)] += 1;
  return c;
}

/** Identifiant du groupe d'une application dans une zone. */
export const clusterId = (zone: ZoneId, appId: string | null) => `cluster:${zone}:${appId ?? '_'}`;

/** Zone qui contient un nœud du graphe (en remontant les parents), ou null (bande). */
export function zoneOfNode(graph: Pick<MapGraph, 'nodes'>, id: string): ZoneId | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let cur = byId.get(id);
  while (cur) {
    if (cur.type === 'zone') return cur.id as ZoneId;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

const GROUP = { draggable: false, selectable: false, focusable: false } as const;

export function buildGraph(map: MapData, { envs, unspecified = true, simulate = null, focus = null, states }: BuildOptions): MapGraph {
  const zones = visibleZones(map, envs, unspecified);
  const zoneSet = new Set<string>(zones);

  const kept = map.nodes.filter((n) => n.type !== 'server' || zoneSet.has(zoneOf(n.env)));
  const keptIds = new Set(kept.map((n) => n.id));
  const byId = new Map(kept.map((n) => [n.id, n]));
  const mapEdges = map.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));

  // mise en avant : simulation (origine + touchés) ou nœud choisi hors simulation
  const selected = new Set(simulate?.selected ?? []);
  const impacted = new Set(simulate?.impacted ?? []);
  const simOn = selected.size > 0;
  const near = new Set<string>();
  const focusOn = !simOn && !!focus && keptIds.has(focus);
  if (focusOn) {
    near.add(focus);
    for (const e of mapEdges) {
      if (e.source === focus) near.add(e.target);
      if (e.target === focus) near.add(e.source);
    }
  }
  const lit = (id: string) => selected.has(id) || impacted.has(id);

  // groupe de chaque serveur : sa zone et son application principale (la première par ordre alphabétique)
  // un lien lu dans la documentation mais inactif (à valider, ancien, cible) ne range pas un serveur dans le groupe
  // d'une application (serveur seulement cité : groupe sans application, lien direct marqué) ; un lien retiré
  // de l'inventaire le range comme avant (grisé dans le groupe de son ancienne application)
  const markOf = (e: MapData['edges'][number]) => linkMark({ retired: e.retired, inactive: e.inactive, trust: e.trust, period: e.period });
  const readOnly = (e: MapData['edges'][number]) => {
    const m = markOf(e);
    return m !== null && m !== 'retired';
  };
  const hostsOf = new Map<string, string[]>();
  for (const e of mapEdges) if (e.type === 'runs_on' && !readOnly(e)) (hostsOf.get(e.target) ?? hostsOf.set(e.target, []).get(e.target)!).push(e.source);
  const primaryOf = (serverId: string): string | null => [...(hostsOf.get(serverId) ?? [])].sort()[0] ?? null;
  const clusters = new Map<string, { zone: ZoneId; appId: string | null; servers: string[] }>();
  const clusterOf = new Map<string, string>();
  for (const n of kept) {
    if (n.type !== 'server') continue;
    const zone = zoneOf(n.env);
    const appId = primaryOf(n.id);
    const cid = clusterId(zone, appId);
    if (!clusters.has(cid)) clusters.set(cid, { zone, appId, servers: [] });
    clusters.get(cid)!.servers.push(n.id);
    clusterOf.set(n.id, cid);
  }

  const counts = new Map<ZoneId, number>();
  for (const n of kept) if (n.type === 'server') counts.set(zoneOf(n.env), (counts.get(zoneOf(n.env)) ?? 0) + 1);
  const envOfZone = (z: ZoneId) => ZONE_ORDER.find((x) => x.id === z)!.env;

  const nodes: MapFlowNode[] = [];
  nodes.push({
    id: BAND_ID,
    type: 'band',
    position: { x: 0, y: 0 },
    data: { kind: 'band', applications: kept.filter((n) => n.type === 'application').length, databases: kept.filter((n) => n.type === 'database').length },
    ...GROUP,
    zIndex: 0,
  });
  for (const z of zones) {
    nodes.push({ id: z, type: 'zone', position: { x: 0, y: 0 }, data: { kind: 'zone', env: envOfZone(z), count: counts.get(z) ?? 0 }, ...GROUP, zIndex: 0 });
  }
  for (const [cid, c] of clusters) {
    const data: ClusterData = { kind: 'cluster', env: envOfZone(c.zone), appId: c.appId, label: c.appId ? (byId.get(c.appId)?.label ?? c.appId) : '', count: c.servers.length };
    if (simOn) data.dim = !c.servers.some(lit);
    if (focusOn) data.near = c.appId === focus || c.servers.includes(focus);
    nodes.push({ id: cid, type: 'cluster', parentId: c.zone, position: { x: 0, y: 0 }, data, ...GROUP, zIndex: 1 });
  }
  for (const n of kept) {
    const parentId = n.type === 'server' ? clusterOf.get(n.id)! : BAND_ID;
    const data: ItemData = { kind: n.type, node: n, label: n.label, state: states?.[n.id] ?? n.state, retired: n.retired };
    if (simOn) data.sim = selected.has(n.id) ? 'origin' : impacted.has(n.id) ? 'impacted' : 'dim';
    if (focusOn) {
      data.near = near.has(n.id);
      data.faded = !near.has(n.id);
    }
    nodes.push({ id: n.id, type: n.type, parentId, position: { x: 0, y: 0 }, data, draggable: false, zIndex: 5 });
  }

  // liens : hébergement regroupé (application vers son groupe), les autres tels quels
  const edges: MapFlowEdge[] = [];
  const grouped = new Map<string, MapFlowEdge>();
  const mark = (data: EdgeData, hot: boolean) => {
    if (simOn || focusOn) {
      data.hot = hot;
      data.dim = !hot;
    }
  };
  for (const e of mapEdges) {
    const cid = e.type === 'runs_on' ? clusterOf.get(e.target) : undefined;
    const c = cid ? clusters.get(cid) : undefined;
    if (cid && c && c.appId === e.source && !readOnly(e)) {
      const id = `g:${e.source}>${cid}`;
      const prev = grouped.get(id);
      if (prev) {
        prev.data!.retired = prev.data!.retired && e.retired;
        if (!e.retired) prev.data!.mark = null;
        continue;
      }
      const data: EdgeData = { type: 'runs_on', retired: e.retired, mark: markOf(e), env: envOfZone(c.zone), count: c.servers.length };
      mark(data, simOn ? lit(e.source) && c.servers.some(lit) : e.source === focus || c.servers.includes(focus as string));
      const edge: MapFlowEdge = { id, source: e.source, target: cid, type: 'lyra', data, focusable: false, selectable: false };
      grouped.set(id, edge);
      edges.push(edge);
      continue;
    }
    const data: EdgeData = { type: e.type, retired: e.retired, mark: markOf(e) };
    if (e.type === 'runs_on') data.env = envOfZone(zoneOf(byId.get(e.target)?.env));
    mark(data, simOn ? lit(e.source) && lit(e.target) : e.source === focus || e.target === focus);
    edges.push({ id: `e:${e.id}:${e.source}|${e.target}|${e.type}`, source: e.source, target: e.target, type: 'lyra', data, focusable: false, selectable: false });
  }
  for (const e of edges) e.zIndex = e.data?.hot ? 3 : 2;

  const structureKey = [
    zones.join(','),
    kept.map((n) => `${n.id}@${n.type === 'server' ? clusterOf.get(n.id) : n.type}`).join(','),
    mapEdges.map((e) => `${e.source}>${e.target}:${e.type}`).join(','),
  ].join('#');

  return { nodes, edges, zones, structureKey };
}

// ---------- entrée de la disposition (envoyée au worker) ----------

export interface LayoutBox {
  id: string;
  w: number;
  h: number;
}

export interface LayoutCluster {
  id: string;
  /** application principale du groupe (rangement sous elle) */
  appId: string | null;
  servers: LayoutBox[];
}

export interface LayoutInput {
  /** applications et bases, et les liens entre elles (calls, uses_db) */
  band: { nodes: LayoutBox[]; edges: { id: string; source: string; target: string }[] };
  /** zones dans l'ordre d'affichage, avec leurs groupes de serveurs */
  zones: { id: ZoneId; clusters: LayoutCluster[] }[];
}

export function layoutInputOf(graph: MapGraph): LayoutInput {
  const band = graph.nodes.filter((n): n is ItemNode => n.parentId === BAND_ID);
  const bandIds = new Set(band.map((n) => n.id));
  const clusters = graph.nodes.filter((n): n is ClusterNode => n.type === 'cluster');
  const servers = graph.nodes.filter((n): n is ItemNode => n.type === 'server');
  return {
    band: {
      nodes: band.map((n) => ({ id: n.id, ...size(n.data.kind) })),
      edges: graph.edges.filter((e) => bandIds.has(e.source) && bandIds.has(e.target)).map((e) => ({ id: e.id, source: e.source, target: e.target })),
    },
    zones: graph.zones.map((z) => ({
      id: z,
      clusters: clusters
        .filter((c) => c.parentId === z)
        .map((c) => ({
          id: c.id,
          appId: c.data.appId,
          servers: servers.filter((s) => s.parentId === c.id).map((s) => ({ id: s.id, ...size('server') })),
        })),
    })),
  };
}

const size = (kind: MapNode['type']) => ({ w: NODE_SIZE[kind].w, h: NODE_SIZE[kind].h });
