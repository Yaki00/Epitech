/** Niveaux de criticité : les exports utilisent des libellés variés (FR/EN, chiffres). */
export const CRITICALITY = {
  critical: { label: 'Critique', short: 'Critique', rank: 0, dot: 'bg-red-500', text: 'text-red-700', soft: 'bg-red-50', border: 'border-red-400', avatar: 'bg-red-50 text-red-700' },
  high: { label: 'Haute', short: 'Haute', rank: 1, dot: 'bg-orange-500', text: 'text-orange-700', soft: 'bg-orange-50', border: 'border-orange-400', avatar: 'bg-orange-50 text-orange-700' },
  medium: { label: 'Moyenne', short: 'Moyenne', rank: 2, dot: 'bg-amber-500', text: 'text-amber-700', soft: 'bg-amber-50', border: 'border-amber-400', avatar: 'bg-amber-50 text-amber-700' },
  low: { label: 'Faible', short: 'Faible', rank: 3, dot: 'bg-emerald-500', text: 'text-emerald-700', soft: 'bg-emerald-50', border: 'border-emerald-400', avatar: 'bg-emerald-50 text-emerald-700' },
  unknown: { label: 'Non définie', short: 'N/D', rank: 4, dot: 'bg-slate-400', text: 'text-slate-600', soft: 'bg-slate-100', border: 'border-slate-300', avatar: 'bg-slate-100 text-slate-600' },
};

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

/** "il y a 5 min", "il y a 3 j", ou "Jamais". Les dates SQLite sont en UTC sans fuseau. */
export function timeAgo(value, now = Date.now()) {
  if (!value) return 'Jamais';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'Jamais';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return "à l'instant";
  const min = Math.round(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return `il y a ${d} j`;
  return new Date(t).toLocaleDateString('fr-FR');
}

export function formatDateTime(value) {
  if (!value) return '—';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

/** Libellés des sources de données affichés dans l'UI. */
export const SOURCE_LABELS = {
  marketplace: 'Marketplace',
  apm: 'APM',
  naemon: 'Naemon',
  confluence: 'Confluence',
  drawio: 'Schéma draw.io',
  llm: 'Déduit par IA',
  servicenow: 'ServiceNow',
};

export const TYPE_LABELS = {
  application: 'Application',
  server: 'Serveur',
  database: 'Base',
  filesystem: 'Filesystem',
  queue: 'File',
  url: 'URL',
  document: 'Document',
  team: 'Équipe',
  unknown: 'Inconnu',
};
