/** Petits composants d'interface partagés. */
import { CRITICALITY, normalizeCriticality, initials, criticalityLabel, sourceLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { AlertIcon } from './Icons';

export function Card({ className = '', children, ...rest }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Tuile de chiffre-clé. `accent` colore la bordure gauche et le chiffre. */
const ACCENTS = {
  none: { border: '', value: 'text-slate-900' },
  red: { border: 'border-l-4 border-l-red-400', value: 'text-red-600' },
  orange: { border: 'border-l-4 border-l-orange-400', value: 'text-orange-600' },
  amber: { border: 'border-l-4 border-l-amber-400', value: 'text-amber-600' },
  blue: { border: '', value: 'text-blue-700' },
  redText: { border: '', value: 'text-red-600' },
  orangeText: { border: '', value: 'text-orange-600' },
};

export function StatCard({ value, label, accent = 'none', hint, centered = false }) {
  const a = ACCENTS[accent] || ACCENTS.none;
  return (
    <Card className={`px-6 py-5 ${a.border} ${centered ? 'text-center' : ''}`}>
      <div className={`text-4xl font-bold tracking-tight ${a.value}`}>{value ?? '—'}</div>
      <div className="mt-1 text-sm text-slate-600">{label}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}

export function CriticalityBadge({ value, size = 'md' }) {
  useI18n(); // se redessine au changement de langue
  const level = normalizeCriticality(value);
  const c = CRITICALITY[level];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full ${c.soft} ${c.text} ${size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'} font-medium`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {criticalityLabel(level)}
    </span>
  );
}

export function AppAvatar({ name, criticality, size = 'md', solid = false }) {
  const c = CRITICALITY[normalizeCriticality(criticality)];
  const sizes = { md: 'h-12 w-12 text-base', lg: 'h-16 w-16 text-2xl' };
  const color = solid ? 'bg-blue-600 text-white shadow-md shadow-blue-600/20' : c.avatar;
  return <div className={`flex shrink-0 items-center justify-center rounded-xl font-bold ${sizes[size]} ${color}`}>{initials(name)}</div>;
}

export function Spinner({ label }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      {label || t('common.loading')}
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <AlertIcon className="mt-0.5 shrink-0" width={18} height={18} />
      <div className="flex-1">
        <div className="font-medium">{t('common.loadError')}</div>
        <div className="text-red-700">{error?.message || String(error)}</div>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="rounded-lg border border-red-300 bg-white px-3 py-1 text-red-700 hover:bg-red-100">
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
      <div className="font-medium text-slate-700">{title}</div>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

/** Indicateur "source non connectée" : jamais un 0 trompeur. */
export function NotConnected({ source }) {
  const { t } = useI18n();
  return <EmptyState title={t('common.notConnectedTitle', { source })}>{t('common.notConnectedText', { source })}</EmptyState>;
}

/** Contrôle segmenté (pilules noires comme la v1). */
export function Segmented({ options, value, onChange, className = '' }) {
  return (
    <div className={`inline-flex rounded-xl border border-slate-200 bg-white p-1 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition ${
            value === o.value ? 'bg-slate-900 text-white shadow' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          {o.label}
          {o.count !== undefined && <span className={`ml-1.5 ${value === o.value ? 'text-slate-300' : 'text-slate-400'}`}>({o.count})</span>}
        </button>
      ))}
    </div>
  );
}

export function SourcePill({ source, confidence }) {
  useI18n();
  const ai = source === 'llm';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${ai ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>
      {sourceLabel(source)}
      {confidence !== undefined && confidence < 1 && <span className="ml-1 opacity-70">{Math.round(confidence * 100)}%</span>}
    </span>
  );
}
