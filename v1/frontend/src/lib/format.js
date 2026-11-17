import { getLang, t } from './i18n';

/** Niveaux de criticité : les exports utilisent des libellés variés (FR/EN, chiffres). Libellés : criticalityLabel(). */
export const CRITICALITY = {
  critical: { rank: 0, dot: 'bg-red-500', text: 'text-red-700', soft: 'bg-red-50', border: 'border-red-400', avatar: 'bg-red-50 text-red-700' },
  high: { rank: 1, dot: 'bg-orange-500', text: 'text-orange-700', soft: 'bg-orange-50', border: 'border-orange-400', avatar: 'bg-orange-50 text-orange-700' },
  medium: { rank: 2, dot: 'bg-amber-500', text: 'text-amber-700', soft: 'bg-amber-50', border: 'border-amber-400', avatar: 'bg-amber-50 text-amber-700' },
  low: { rank: 3, dot: 'bg-emerald-500', text: 'text-emerald-700', soft: 'bg-emerald-50', border: 'border-emerald-400', avatar: 'bg-emerald-50 text-emerald-700' },
  unknown: { rank: 4, dot: 'bg-slate-400', text: 'text-slate-600', soft: 'bg-slate-100', border: 'border-slate-300', avatar: 'bg-slate-100 text-slate-600' },
};

export const criticalityLabel = (level) => t(`crit.${level}`);

export function normalizeCriticality(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (!s) return 'unknown';
  if (/^(critique|critical|crit|vital|p1|tier ?0|tier ?1|1)$/.test(s) || s.includes('critiq') || s.includes('critical')) return 'critical';
  if (/^(haute?|high|elevee?|important|p2|tier ?2|2)$/.test(s) || s.startsWith('haut') || s.startsWith('high')) return 'high';
  if (/^(moyenne?|medium|moyen|normal|standard|p3|tier ?3|3)$/.test(s) || s.startsWith('moy') || s.startsWith('med')) return 'medium';
  if (/^(faible|basse?|low|mineure?|p4|tier ?4|4|5)$/.test(s) || s.startsWith('faib') || s.startsWith('low') || s.startsWith('bas')) return 'low';
  return 'unknown';
}

export function initials(name) {
  const clean = String(name || '?').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim();
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase() || '?';
}

const LOCALES = { fr: 'fr-FR', en: 'en-GB' };
const toDate = (value) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`);

/** "il y a 5 min" / "5 min ago", ou "Jamais". Les dates sans fuseau sont en UTC. */
export function timeAgo(value, now = Date.now()) {
  if (!value) return t('time.never');
  const time = toDate(value).getTime();
  if (!Number.isFinite(time)) return t('time.never');
  const sec = Math.max(0, Math.round((now - time) / 1000));
  if (sec < 60) return t('time.now');
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.min', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('time.hour', { n: h });
  const d = Math.round(h / 24);
  if (d < 31) return t('time.day', { n: d });
  return new Date(time).toLocaleDateString(LOCALES[getLang()]);
}

export function formatDateTime(value) {
  if (!value) return '';
  const d = toDate(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(LOCALES[getLang()], { dateStyle: 'short', timeStyle: 'short' }) : '';
}

/** Libellés traduits : source d'une donnée, type d'élément, type de lien. Inconnu = valeur brute. */
const label = (prefix, value) => {
  const text = t(`${prefix}.${value}`);
  return text === `${prefix}.${value}` ? value : text;
};
export const sourceLabel = (source) => label('source', source);
export const typeLabel = (type) => label('type', type);
export const edgeLabel = (type) => label('edge', type);
