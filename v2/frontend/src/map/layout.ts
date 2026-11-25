/**
 * Calcul de la disposition dans un Web Worker (un seul, réutilisé), avec mémoire des derniers résultats :
 * la même structure n'est jamais recalculée (les états rafraîchis chaque minute ne changent que les couleurs).
 * Sans Worker (tests, navigateur très ancien) ou si le worker échoue, le calcul se fait dans la page.
 */
import type { LayoutInput } from './buildGraph';
import type { LayoutResult } from './layoutCore';

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: LayoutResult) => void; reject: (e: Error) => void }>();
const cache = new Map<string, Promise<LayoutResult>>();
const CACHE_MAX = 8;

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: LayoutResult; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.result) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error || 'layout'));
    };
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const p of pending.values()) p.reject(new Error('worker'));
      pending.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

async function inPage(input: LayoutInput): Promise<LayoutResult> {
  const [{ default: ELK }, { computeLayout }] = await Promise.all([import('elkjs/lib/elk.bundled.js'), import('./layoutCore')]);
  return computeLayout(input, new ELK());
}

function viaWorker(input: LayoutInput): Promise<LayoutResult> {
  const w = getWorker();
  if (!w) return inPage(input);
  const id = ++seq;
  return new Promise<LayoutResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, input });
  }).catch(() => inPage(input));
}

/** Disposition d'une structure ; `key` identifie la structure (MapGraph.structureKey). */
export function runLayout(key: string, input: LayoutInput): Promise<LayoutResult> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = viaWorker(input);
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return p;
}
