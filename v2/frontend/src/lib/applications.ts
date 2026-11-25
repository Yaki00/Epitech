/**
 * Logique pure des pages Applications et fiche application : filtres de la liste, rang de criticité,
 * changements d'historique qui touchent une application, lecture des ids de liens.
 */
import type { AppState, ApplicationSummary, Change, ChangeAttr } from './api';
import { normalize } from './search';

// ---------- criticité ----------

/** Niveaux connus (APM en français ou en anglais) ; le texte reste affiché tel quel. */
const CRITICALITY_LEVELS: [number, string[]][] = [
  [4, ['critique', 'critical', 'tres haute', 'very high', 'vitale', 'vital']],
  [3, ['haute', 'high', 'elevee', 'forte', 'importante', 'important']],
  [2, ['moyenne', 'medium', 'moyen', 'normale', 'normal']],
  [1, ['basse', 'low', 'faible', 'mineure', 'minor']],
];

/** Rang pour trier (4 = critique) ; texte inconnu = 0 ; absent = -1. */
export function criticalityRank(value: string | null | undefined): number {
  if (!value) return -1;
  const v = normalize(value);
  for (const [rank, words] of CRITICALITY_LEVELS) if (words.includes(v)) return rank;
  return 0;
}

/** Valeurs de criticité présentes, de la plus haute à la plus basse. */
export function criticalityOptions(apps: readonly { criticality: string | null }[]): string[] {
  const set = new Set<string>();
  for (const a of apps) if (a.criticality) set.add(a.criticality);
  return [...set].sort((a, b) => criticalityRank(b) - criticalityRank(a) || a.localeCompare(b));
}

// ---------- filtres de la liste ----------

export type StateFilter = 'all' | AppState | 'atRisk';
export type PerimeterFilter = 'all' | 'in' | 'out';

export interface AppFilters {
  q: string;
  state: StateFilter;
  /** 'all' ou valeur exacte de criticité ; 'none' = criticité non renseignée */
  criticality: string;
  perimeter: PerimeterFilter;
  /** afficher les applications retirées */
  retired: boolean;
}

export const DEFAULT_APP_FILTERS: AppFilters = { q: '', state: 'all', criticality: 'all', perimeter: 'all', retired: false };

const STATE_FILTERS: StateFilter[] = ['all', 'ok', 'degraded', 'down', 'unknown', 'atRisk'];
const PERIMETER_FILTERS: PerimeterFilter[] = ['all', 'in', 'out'];

/** Lit les filtres dans l'adresse (?q=&state=&crit=&scope=&retired=1) ; valeur inattendue = défaut. */
export function filtersFromParams(params: URLSearchParams): AppFilters {
  const state = params.get('state') as StateFilter | null;
  const perimeter = params.get('scope') as PerimeterFilter | null;
  return {
    q: params.get('q') ?? '',
    state: state && STATE_FILTERS.includes(state) ? state : 'all',
    criticality: params.get('crit') || 'all',
    perimeter: perimeter && PERIMETER_FILTERS.includes(perimeter) ? perimeter : 'all',
    retired: params.get('retired') === '1',
  };
}

/** Écrit les filtres dans l'adresse ; les valeurs par défaut sont omises. */
export function filtersToParams(f: AppFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q);
  if (f.state !== 'all') p.set('state', f.state);
  if (f.criticality !== 'all') p.set('crit', f.criticality);
  if (f.perimeter !== 'all') p.set('scope', f.perimeter);
  if (f.retired) p.set('retired', '1');
  return p;
}

export const hasActiveFilters = (f: AppFilters): boolean => filtersToParams(f).toString() !== '';

/** Applique les filtres (texte sur le nom, le résumé et la criticité, sans casse ni accents). */
export function filterApplications<T extends ApplicationSummary>(apps: readonly T[], f: AppFilters): T[] {
  const q = normalize(f.q);
  return apps.filter((a) => {
    if (a.retired && !f.retired) return false;
    if (f.perimeter === 'in' && !a.inPerimeter) return false;
    if (f.perimeter === 'out' && a.inPerimeter) return false;
    if (f.criticality === 'none' ? a.criticality : f.criticality !== 'all' && a.criticality !== f.criticality) return false;
    if (f.state === 'atRisk' ? !a.status?.atRisk : f.state !== 'all' && (a.status?.state ?? 'unknown') !== f.state) return false;
    if (q && !normalize(`${a.name} ${a.summary ?? ''} ${a.criticality ?? ''}`).includes(q)) return false;
    return true;
  });
}

// ---------- ids de nœuds et de liens ----------

export interface LinkId {
  src: string;
  dst: string;
  type: string;
  source: string;
}

/** Id de lien `src|dst|type|source` ; null pour un id de nœud. */
export function parseLinkId(id: string): LinkId | null {
  const parts = id.split('|');
  if (parts.length !== 4) return null;
  const [src = '', dst = '', type = '', source = ''] = parts;
  return { src, dst, type, source };
}

/** Nom lisible d'un nœud : libellé connu, sinon la clé sans le préfixe de type. */
export function nodeLabel(id: string, labels: Record<string, string> | undefined): string {
  const known = labels?.[id];
  if (known) return known;
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** Type d'un nœud d'après son id (`server:x` → `server`). */
export const nodeType = (id: string): string => {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(0, i) : '';
};

// ---------- historique d'une application ----------

const touches = (id: string, ids: ReadonlySet<string>): boolean => {
  if (ids.has(id)) return true;
  const link = parseLinkId(id);
  return Boolean(link && (ids.has(link.src) || ids.has(link.dst)));
};

/**
 * Changements qui touchent un ensemble de nœuds (l'application, ses serveurs, ses bases) :
 * chaque changement ne garde que les éléments concernés ; les changements vides sont retirés.
 */
export function changesTouching(changes: readonly Change[], ids: ReadonlySet<string>): Change[] {
  const out: Change[] = [];
  for (const c of changes) {
    const added = c.added.filter((id) => touches(id, ids));
    const removed = c.removed.filter((id) => touches(id, ids));
    const changed: ChangeAttr[] = c.changed.filter((x) => touches(x.id, ids));
    if (added.length || removed.length || changed.length) out.push({ ...c, added, removed, changed });
  }
  return out;
}

/** Nombre d'éléments d'un changement : ajouts et retraits de nœuds (les liens sont comptés à part). */
export function changeCounts(c: Pick<Change, 'added' | 'removed' | 'changed'>) {
  const nodes = (ids: string[]) => ids.filter((id) => !parseLinkId(id)).length;
  return {
    addedNodes: nodes(c.added),
    removedNodes: nodes(c.removed),
    addedLinks: c.added.length - nodes(c.added),
    removedLinks: c.removed.length - nodes(c.removed),
    changed: c.changed.length,
  };
}

/** Valeur d'attribut lisible (avant / après) ; absente = null. */
export function attrValue(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------- divers ----------

/** Date SQLite « 2026-11-22 11:30:44 » (UTC, sans fuseau) vers ISO ; autre valeur : inchangée. */
export function sqlDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
}

export interface AuditInfo {
  /** true : cohérente avec les inventaires ; false : écarts ; null : pas de contrôle */
  ok: boolean | null;
  env: string | null;
  problems: { code: string; n: number }[];
}

/** Lecture prudente du contrôle d'une page d'architecture (champ `audit` libre côté serveur). */
export function auditInfo(audit: Record<string, unknown> | null | undefined): AuditInfo {
  if (!audit || typeof audit !== 'object') return { ok: null, env: null, problems: [] };
  const problems = Array.isArray(audit.problems)
    ? audit.problems
        .filter((p): p is { code: string; n?: unknown } => Boolean(p) && typeof (p as { code?: unknown }).code === 'string')
        .map((p) => ({ code: p.code, n: typeof p.n === 'number' ? p.n : 1 }))
    : [];
  const ok = typeof audit.ok === 'boolean' ? audit.ok : problems.length === 0;
  return { ok, env: typeof audit.environment === 'string' ? audit.environment : null, problems };
}

// ---------- flux ----------

/**
 * Nombre de flux de l'onglet Flux : appels sortants et entrants actifs seulement (un appel ancien, cible,
 * à valider ou retiré est grisé et masqué par défaut, il ne compte pas).
 */
export function flowCount(app: { callsList: readonly { retired: boolean }[]; usedBy: readonly { retired: boolean }[] }): number {
  return app.callsList.filter((c) => !c.retired).length + app.usedBy.filter((u) => !u.retired).length;
}
