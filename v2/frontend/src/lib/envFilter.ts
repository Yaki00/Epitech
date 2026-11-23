/**
 * Filtre d'environnements commun (liste des serveurs, onglets de la fiche application) :
 * PRD et STG par défaut, DEV d'un clic. Les serveurs sans environnement (« Non précisé »)
 * restent visibles par défaut pour ne jamais être perdus. Le choix est mémorisé dans le navigateur.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Env } from './api';
import { ENVS } from './status';

export interface EnvFilterValue {
  envs: Env[];
  /** serveurs sans environnement (env null) */
  unspecified: boolean;
}

export const DEFAULT_ENVS: Env[] = ['PRD', 'STG'];
export const DEFAULT_ENV_FILTER: EnvFilterValue = { envs: DEFAULT_ENVS, unspecified: true };
export const ENV_FILTER_STORAGE_KEY = 'lyra.envFilter';

/** Lecture d'une valeur mémorisée ; illisible ou invalide : filtre par défaut. */
export function parseEnvFilter(raw: string | null | undefined): EnvFilterValue {
  if (!raw) return DEFAULT_ENV_FILTER;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return DEFAULT_ENV_FILTER;
    const { envs, unspecified } = v as { envs?: unknown; unspecified?: unknown };
    if (!Array.isArray(envs) || typeof unspecified !== 'boolean') return DEFAULT_ENV_FILTER;
    if (!envs.every((e) => (ENVS as readonly unknown[]).includes(e))) return DEFAULT_ENV_FILTER;
    return { envs: ENVS.filter((e) => envs.includes(e)), unspecified };
  } catch {
    return DEFAULT_ENV_FILTER;
  }
}

export const serializeEnvFilter = (f: EnvFilterValue): string => JSON.stringify({ envs: f.envs, unspecified: f.unspecified });

/** Un serveur est affiché si son environnement est coché (env null : case « Non précisé »). */
export const envVisible = (f: EnvFilterValue, env: Env | null): boolean => (env === null ? f.unspecified : f.envs.includes(env));

/** Bascule un environnement et garde l'ordre PRD, STG, DEV. */
export function toggleEnv(f: EnvFilterValue, env: Env, on: boolean): EnvFilterValue {
  return { ...f, envs: ENVS.filter((e) => (e === env ? on : f.envs.includes(e))) };
}

// ---------- état partagé et mémorisé ----------

let current: EnvFilterValue | null = null;
const listeners = new Set<() => void>();

function read(): EnvFilterValue {
  if (current) return current;
  try {
    current = parseEnvFilter(localStorage.getItem(ENV_FILTER_STORAGE_KEY));
  } catch {
    current = DEFAULT_ENV_FILTER;
  }
  return current;
}

function write(next: EnvFilterValue): void {
  current = next;
  try {
    localStorage.setItem(ENV_FILTER_STORAGE_KEY, serializeEnvFilter(next));
  } catch {
    /* stockage indisponible : le réglage vaut pour la session */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Pour les tests : oublie l'état en mémoire. */
export function resetEnvFilter(): void {
  current = null;
  listeners.forEach((l) => l());
}

/** Filtre d'environnements partagé par toutes les pages (mémorisé). */
export function useEnvFilter(): [EnvFilterValue, (next: EnvFilterValue) => void] {
  const value = useSyncExternalStore(subscribe, read, () => DEFAULT_ENV_FILTER);
  const set = useCallback((next: EnvFilterValue) => write(next), []);
  return [value, set];
}
