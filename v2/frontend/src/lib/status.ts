/**
 * États de supervision et environnements : couleur (ton), icône, libellé, gravité.
 * Un état n'est jamais montré par la couleur seule : toujours une icône et un libellé (StatusPill).
 * Les classes Tailwind sont écrites en entier (pas de concaténation) pour être trouvées à la compilation.
 */
import { CircleCheck, CircleHelp, CircleX, EyeOff, OctagonAlert, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react';
import type { AppState, Env, ServerState, ServiceCode } from './api';
import type { Key } from './i18n';

export type AnyState = ServerState | AppState;
export type Tone = 'ok' | 'warn' | 'crit' | 'down' | 'maint' | 'unknown' | 'unmon';

export interface StateMeta {
  state: AnyState;
  tone: Tone;
  icon: LucideIcon;
  labelKey: Key;
  /** gravité : plus grand = plus grave (tri « le pire d'abord ») */
  rank: number;
}

const META: Record<AnyState, StateMeta> = {
  down: { state: 'down', tone: 'down', icon: CircleX, labelKey: 'state.down', rank: 6 },
  critical: { state: 'critical', tone: 'crit', icon: OctagonAlert, labelKey: 'state.critical', rank: 5 },
  warning: { state: 'warning', tone: 'warn', icon: TriangleAlert, labelKey: 'state.warning', rank: 4 },
  degraded: { state: 'degraded', tone: 'warn', icon: TriangleAlert, labelKey: 'state.degraded', rank: 4 },
  unknown: { state: 'unknown', tone: 'unknown', icon: CircleHelp, labelKey: 'state.unknown', rank: 3 },
  not_monitored: { state: 'not_monitored', tone: 'unmon', icon: EyeOff, labelKey: 'state.not_monitored', rank: 2 },
  maintenance: { state: 'maintenance', tone: 'maint', icon: Wrench, labelKey: 'state.maintenance', rank: 1 },
  ok: { state: 'ok', tone: 'ok', icon: CircleCheck, labelKey: 'state.ok', rank: 0 },
};

export const SERVER_STATES: ServerState[] = ['down', 'critical', 'warning', 'unknown', 'not_monitored', 'maintenance', 'ok'];
export const APP_STATES: AppState[] = ['down', 'degraded', 'unknown', 'ok'];

export const isKnownState = (s: unknown): s is AnyState => typeof s === 'string' && Object.prototype.hasOwnProperty.call(META, s);

/** Description d'un état ; valeur absente ou inattendue = « unknown » (jamais un faux OK). */
export function stateMeta(state: string | null | undefined): StateMeta {
  return isKnownState(state) ? META[state] : META.unknown;
}

export const severity = (state: string | null | undefined): number => stateMeta(state).rank;

/** Comparateur pour trier du plus grave au moins grave. */
export const bySeverity = (a: string | null | undefined, b: string | null | undefined): number => severity(b) - severity(a);

/** État le plus grave d'une liste (liste vide : « unknown »). */
export function worstState<S extends AnyState>(states: readonly S[]): S | 'unknown' {
  let worst: S | 'unknown' = 'unknown';
  let rank = -1;
  for (const s of states) {
    const r = severity(s);
    if (r > rank) {
      rank = r;
      worst = s;
    }
  }
  return worst;
}

/** Vrai pour un état qui demande de l'attention (panne, critique, alerte, dégradé). */
export const isAlerting = (state: string | null | undefined): boolean => ['down', 'critical', 'warning', 'degraded'].includes(String(state));

/** État d'un service Naemon (code 0 à 3) ; un arrêt planifié prime : « maintenance ». */
export function serviceState(code: ServiceCode | number, downtime = false): ServerState {
  if (downtime) return 'maintenance';
  switch (code) {
    case 0:
      return 'ok';
    case 1:
      return 'warning';
    case 2:
      return 'critical';
    default:
      return 'unknown';
  }
}

/** Classes par ton : texte, fond doux, bordure, pastille pleine. */
export const TONE_CLASSES: Record<Tone, { text: string; soft: string; border: string; dot: string }> = {
  ok: { text: 'text-ok', soft: 'bg-ok-soft', border: 'border-ok/35', dot: 'bg-ok' },
  warn: { text: 'text-warn', soft: 'bg-warn-soft', border: 'border-warn/40', dot: 'bg-warn' },
  crit: { text: 'text-crit', soft: 'bg-crit-soft', border: 'border-crit/40', dot: 'bg-crit' },
  down: { text: 'text-down', soft: 'bg-down-soft', border: 'border-down/40', dot: 'bg-down' },
  maint: { text: 'text-maint', soft: 'bg-maint-soft', border: 'border-maint/40', dot: 'bg-maint' },
  unknown: { text: 'text-unknown', soft: 'bg-unknown-soft', border: 'border-unknown/30', dot: 'bg-unknown' },
  // « non supervisé » : contour pointillé, sans fond (absence de donnée, pas un état mesuré)
  unmon: { text: 'text-unmon', soft: 'bg-transparent', border: 'border-unmon/60 border-dashed', dot: 'bg-unmon' },
};

// ---------- environnements ----------

export const ENVS: Env[] = ['PRD', 'STG', 'DEV'];
export type EnvKey = Env | 'none';

/** Environnement d'affichage : null ou valeur inattendue = « none » (zone « Non précisé »). */
export const envKey = (env: string | null | undefined): EnvKey => (env === 'PRD' || env === 'STG' || env === 'DEV' ? env : 'none');

export const envLabelKey = (env: string | null | undefined): Key => `env.${envKey(env)}` as Key;
export const envShortKey = (env: string | null | undefined): Key => `env.short.${envKey(env)}` as Key;

export const ENV_CLASSES: Record<EnvKey, { text: string; soft: string; border: string; dot: string }> = {
  PRD: { text: 'text-env-prd', soft: 'bg-env-prd-soft', border: 'border-env-prd/40', dot: 'bg-env-prd' },
  STG: { text: 'text-env-stg', soft: 'bg-env-stg-soft', border: 'border-env-stg/40', dot: 'bg-env-stg' },
  DEV: { text: 'text-env-dev', soft: 'bg-env-dev-soft', border: 'border-env-dev/40', dot: 'bg-env-dev' },
  none: { text: 'text-env-none', soft: 'bg-env-none-soft', border: 'border-env-none/40 border-dashed', dot: 'bg-env-none' },
};
