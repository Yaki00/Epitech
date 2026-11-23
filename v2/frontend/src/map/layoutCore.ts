/**
 * Disposition de la cartographie (exécutée dans un Web Worker, voir layout.worker.ts).
 *
 * 1. Bande « Applications » : ELK `layered` de haut en bas sur les applications et les bases
 *    (liens calls et uses_db) : appelants en haut, appelés et bases en dessous.
 * 2. Zones d'environnement côte à côte sous la bande (PRD à gauche, puis STG, DEV, « Non précisé ») :
 *    dans chaque zone, un groupe de serveurs par application (grille compacte de 4 lignes au plus),
 *    groupes rangés en étagères selon la position de leur application dans la bande (les liens
 *    descendent ainsi sans se croiser inutilement). Toutes les zones ont la même hauteur.
 *
 * Les positions rendues sont relatives au groupe parent (bande ou zone), comme l'attend React Flow.
 */
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import type { LayoutInput } from './buildGraph';

export const LAYOUT = {
  bandPad: 24,
  bandHeader: 44,
  zonePad: 14,
  zoneHeader: 56,
  clusterHeader: 24,
  clusterPad: 7,
  clusterRows: 4,
  clusterGap: 12,
  colGap: 8,
  rowGap: 6,
  zoneGap: 28,
  bandToZones: 88,
  minZoneWidth: 290,
  emptyZoneHeight: 120,
  /** largeur visée de l'ensemble des zones par rapport à leur hauteur */
  aspect: 5,
} as const;

export interface LayoutResult {
  /** position relative au parent pour chaque nœud (bande et zones : position absolue) */
  positions: Record<string, { x: number; y: number }>;
  /** taille des groupes (bande, zones, groupes de serveurs) */
  sizes: Record<string, { w: number; h: number }>;
  width: number;
  height: number;
}

const BAND_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'SPLINES',
  'elk.spacing.nodeNode': '24',
  'elk.layered.spacing.nodeNodeBetweenLayers': '44',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '36',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};

interface Shelf {
  items: { id: string; x: number; w: number; h: number }[];
  w: number;
  h: number;
}

/** Range des boîtes de gauche à droite en étagères de largeur `maxW` au plus. */
export function shelfPack(boxes: { id: string; w: number; h: number }[], maxW: number, gap: number): { shelves: Shelf[]; w: number; h: number } {
  const shelves: Shelf[] = [];
  let cur: Shelf | null = null;
  for (const b of boxes) {
    if (!cur || (cur.items.length && cur.w + gap + b.w > maxW)) {
      cur = { items: [], w: 0, h: 0 };
      shelves.push(cur);
    }
    const x: number = cur.items.length ? cur.w + gap : 0;
    cur.items.push({ id: b.id, x, w: b.w, h: b.h });
    cur.w = x + b.w;
    cur.h = Math.max(cur.h, b.h);
  }
  return {
    shelves,
    w: Math.max(0, ...shelves.map((s) => s.w)),
    h: shelves.reduce((sum, s) => sum + s.h, 0) + Math.max(0, shelves.length - 1) * gap,
  };
}

export async function computeLayout(input: LayoutInput, elk: Pick<ELK, 'layout'>): Promise<LayoutResult> {
  const L = LAYOUT;
  const positions: LayoutResult['positions'] = {};
  const sizes: LayoutResult['sizes'] = {};

  // ---- bande : ELK layered (d'abord : l'ordre des groupes de serveurs suit la position des applications) ----
  let contentW = 0;
  let contentH = 0;
  const bandPos: Record<string, { x: number; y: number }> = {};
  if (input.band.nodes.length) {
    const graph: ElkNode = {
      id: 'band',
      layoutOptions: { ...BAND_OPTIONS, 'elk.aspectRatio': '3.2' },
      children: input.band.nodes.map((n) => ({ id: n.id, width: n.w, height: n.h })),
      edges: input.band.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    const out = await elk.layout(graph);
    for (const c of out.children ?? []) bandPos[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
    contentW = out.width ?? 0;
    contentH = out.height ?? 0;
  }
  const appCenter = new Map<string, number>();
  for (const n of input.band.nodes) appCenter.set(n.id, (bandPos[n.id]?.x ?? 0) + n.w / 2);

  // ---- groupes de serveurs : taille ----
  const clusterBox = new Map<string, { w: number; h: number; cols: number; rows: number }>();
  for (const z of input.zones) {
    for (const c of z.clusters) {
      const n = c.servers.length;
      const sw = c.servers[0]?.w ?? 144;
      const sh = c.servers[0]?.h ?? 30;
      const cols = Math.max(1, Math.ceil(n / L.clusterRows));
      const rows = Math.max(1, Math.ceil(n / cols));
      clusterBox.set(c.id, {
        w: cols * (sw + L.colGap) - L.colGap + 2 * L.clusterPad,
        h: L.clusterHeader + rows * (sh + L.rowGap) - L.rowGap + L.clusterPad,
        cols,
        rows,
      });
    }
  }

  // ---- zones : même hauteur pour toutes, largeur totale proche de celle de la bande ----
  // pour une hauteur H, chaque zone prend la plus petite largeur qui tient en H (étagères) ;
  // on cherche la plus petite H dont la largeur totale ne dépasse pas la largeur visée.
  const area = (cs: { id: string }[]) => cs.reduce((s, c) => s + (clusterBox.get(c.id)!.w + L.clusterGap) * (clusterBox.get(c.id)!.h + L.clusterGap), 0);
  const totalArea = input.zones.reduce((s, z) => s + area(z.clusters), 0);
  const targetW = Math.max(contentW, Math.sqrt(totalArea * L.aspect));
  const anchor = (c: { appId: string | null }) => (c.appId && appCenter.has(c.appId) ? appCenter.get(c.appId)! : Infinity);
  const zoneBoxes = input.zones.map((z) =>
    [...z.clusters].sort((a, b) => anchor(a) - anchor(b) || a.id.localeCompare(b.id)).map((c) => ({ id: c.id, ...clusterBox.get(c.id)! })),
  );
  const fitWidth = (boxes: { id: string; w: number; h: number }[], maxH: number) => {
    const widest = Math.max(0, ...boxes.map((b) => b.w));
    let lo = widest;
    let hi = Math.max(widest, boxes.reduce((s, b) => s + b.w + L.clusterGap, 0));
    if (shelfPack(boxes, lo, L.clusterGap).h <= maxH) return lo;
    for (let i = 0; i < 24 && hi - lo > 4; i++) {
      const mid = (lo + hi) / 2;
      if (shelfPack(boxes, mid, L.clusterGap).h <= maxH) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const totalFor = (maxH: number) => zoneBoxes.reduce((s, b) => s + Math.max(L.minZoneWidth - 2 * L.zonePad, fitWidth(b, maxH)) + 2 * L.zonePad + L.zoneGap, -L.zoneGap);
  let hLo = Math.max(0, ...[...clusterBox.values()].map((b) => b.h));
  let hHi = Math.max(hLo, zoneBoxes.reduce((s, b) => Math.max(s, b.reduce((t, x) => t + x.h + L.clusterGap, 0)), 0));
  if (totalFor(hLo) > targetW) {
    for (let i = 0; i < 24 && hHi - hLo > 4; i++) {
      const mid = (hLo + hHi) / 2;
      if (totalFor(mid) <= targetW) hHi = mid;
      else hLo = mid;
    }
  } else hHi = hLo;
  const packed = input.zones.map((z, i) => ({ zone: z, ...shelfPack(zoneBoxes[i], fitWidth(zoneBoxes[i], hHi), L.clusterGap) }));
  const zoneWidth = (p: (typeof packed)[number]) => Math.max(L.minZoneWidth, p.w + 2 * L.zonePad);
  const innerH = Math.max(0, ...packed.map((p) => p.h));
  const zoneH = L.zoneHeader + Math.max(innerH, L.emptyZoneHeight - L.zoneHeader - L.zonePad) + L.zonePad;
  const zonesW = packed.reduce((s, p) => s + zoneWidth(p), 0) + Math.max(0, packed.length - 1) * L.zoneGap;

  // ---- bande : position ----
  const width = Math.max(zonesW, contentW + 2 * L.bandPad, L.minZoneWidth);
  const bandH = L.bandHeader + Math.max(contentH, 24) + L.bandPad;
  const offsetX = (width - contentW) / 2;
  positions['band-apps'] = { x: 0, y: 0 };
  sizes['band-apps'] = { w: width, h: bandH };
  for (const n of input.band.nodes) {
    const p = bandPos[n.id] ?? { x: 0, y: 0 };
    positions[n.id] = { x: offsetX + p.x, y: L.bandHeader + p.y };
  }

  // ---- zones, groupes et serveurs ----
  let x = (width - zonesW) / 2;
  const y = bandH + L.bandToZones;
  for (const p of packed) {
    const w = zoneWidth(p);
    positions[p.zone.id] = { x, y };
    sizes[p.zone.id] = { w, h: zoneH };
    const left = (w - p.w) / 2;
    let top = L.zoneHeader;
    for (const shelf of p.shelves) {
      for (const it of shelf.items) {
        const box = clusterBox.get(it.id)!;
        positions[it.id] = { x: left + it.x, y: top };
        sizes[it.id] = { w: box.w, h: box.h };
        const cluster = p.zone.clusters.find((c) => c.id === it.id)!;
        const servers = [...cluster.servers].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
        servers.forEach((s, i) => {
          // colonne par colonne
          const col = Math.floor(i / box.rows);
          const row = i % box.rows;
          positions[s.id] = { x: L.clusterPad + col * (s.w + L.colGap), y: L.clusterHeader + row * (s.h + L.rowGap) };
        });
      }
      top += shelf.h + L.clusterGap;
    }
    x += w + L.zoneGap;
  }

  return { positions, sizes, width, height: y + (packed.length ? zoneH : 0) };
}
