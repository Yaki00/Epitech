/**
 * Libellés des sources de données (APM, Confluence, Naemon...), de l'état de leur dernier import
 * et des types de liens du graphe. Valeur inconnue : affichée telle quelle.
 */
import type { BadgeTone } from '../components/ui';
import type { Key, TFunction } from './i18n';

/** Traduit `prefix.value` si la clé existe, sinon renvoie `value`. */
function known(t: TFunction, prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  const text = t(key as Key);
  return text === key ? value : text;
}

export const sourceLabel = (t: TFunction, source: string): string => known(t, 'source', source);

export const edgeLabel = (t: TFunction, type: string): string => known(t, 'edge', type);

/** État du dernier import d'une source (`success`, `error`, `running`, `ok`, `pending`, `off`, `démo`). */
export function sourceStatus(t: TFunction, status: string): { label: string; tone: BadgeTone } {
  const s = status === 'démo' ? 'demo' : status;
  const tone: BadgeTone =
    s === 'success' || s === 'ok' ? 'ok' : s === 'error' ? 'down' : s === 'demo' ? 'accent' : s === 'off' ? 'unmon' : 'unknown';
  return { label: known(t, 'sourceStatus', s), tone };
}
