/**
 * Formatage des dates et nombres, selon la langue de l'interface.
 * Les dates du serveur sont des chaînes ISO ; `lastCheck` de Naemon est en secondes (epochSeconds).
 */
import { translate, type Lang } from './i18n';

export type DateInput = string | number | Date | null | undefined;

const locale = (lang: Lang) => (lang === 'en' ? 'en-GB' : 'fr-FR');

/** Convertit une date ; valeur absente ou illisible = null. Un nombre est en millisecondes. */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `lastCheck` Naemon (secondes depuis 1970) vers Date. */
export const epochSeconds = (s: number | null | undefined): Date | null => (typeof s === 'number' && s > 0 ? new Date(s * 1000) : null);

/** « il y a 5 min », « à l'instant », « Jamais » (valeur absente). */
export function relativeTime(value: DateInput, lang: Lang, now: number = Date.now()): string {
  const d = toDate(value);
  if (!d) return translate(lang, 'time.never');
  const diff = Math.round((now - d.getTime()) / 1000);
  if (diff < -60) return translate(lang, 'time.inFuture');
  if (diff < 60) return translate(lang, 'time.now');
  const min = Math.floor(diff / 60);
  if (min < 60) return translate(lang, 'time.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return translate(lang, 'time.hour', { n: h });
  return translate(lang, 'time.day', { n: Math.floor(h / 24) });
}

/** Échéance à venir : « dans 4 min », « dans 2 h » ; passée de plus d'une minute : « en attente » ; absente : « Jamais ». */
export function untilTime(value: DateInput, lang: Lang, now: number = Date.now()): string {
  const d = toDate(value);
  if (!d) return translate(lang, 'time.never');
  const diff = Math.round((d.getTime() - now) / 1000);
  if (diff < -60) return translate(lang, 'time.due');
  if (diff < 60) return translate(lang, 'time.inFuture');
  const min = Math.round(diff / 60);
  if (min < 60) return translate(lang, 'time.inMin', { n: min });
  return translate(lang, 'time.inHour', { n: Math.round(min / 60) });
}

/** Date et heure courtes : « 18/11/2026 14:05 ». */
export function formatDateTime(value: DateInput, lang: Lang): string {
  const d = toDate(value);
  if (!d) return translate(lang, 'time.never');
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

/** Date seule : « 18/11/2026 ». */
export function formatDate(value: DateInput, lang: Lang): string {
  const d = toDate(value);
  if (!d) return translate(lang, 'time.never');
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'short' }).format(d);
}

/** Nombre avec séparateur de milliers de la langue. */
export const formatNumber = (n: number, lang: Lang): string => new Intl.NumberFormat(locale(lang)).format(n);
