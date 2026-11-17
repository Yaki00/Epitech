import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { normalizeCriticality, timeAgo, CRITICALITY, criticalityLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { AppAvatar, Card, CriticalityBadge, EmptyState, ErrorBox, Segmented, Spinner, StatCard } from '../components/ui';
import { SearchIcon, ServerIcon, UserIcon } from '../components/Icons';

const LEVELS = ['critical', 'high', 'medium', 'low'];

function AppCard({ app }) {
  const { t } = useI18n();
  const synced = !!app.lastSync;
  return (
    <Link to={`/app/${encodeURIComponent(app.id)}`} className="group block">
      <Card className="flex h-full flex-col p-5 transition group-hover:border-blue-300 group-hover:shadow-md">
        <div className="flex items-start gap-4">
          <AppAvatar name={app.name} criticality={app.criticality} />
          <div className="min-w-0 flex-1 pt-2.5">
            <div title={app.name} className="line-clamp-2 break-words text-lg font-medium leading-snug text-slate-900">
              {app.name}
            </div>
          </div>
          <div className="shrink-0">
            <CriticalityBadge value={app.criticality} size="sm" />
          </div>
        </div>
        <div className="mt-3 flex gap-4 pl-16 text-xs text-slate-500">
          <span>{t('apps.servers', { n: app.servers })}</span>
          <span>{t('apps.databases', { n: app.databases })}</span>
        </div>
        <div className="mt-auto flex items-center justify-between pt-5 text-sm text-slate-500">
          <span className="flex min-w-0 items-center gap-1.5">
            <UserIcon width={16} height={16} className="shrink-0" />
            <span className="truncate" title={app.owner || app.supportTeam || ''}>
              {app.owner || app.supportTeam || ''}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${synced ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            {timeAgo(app.lastSync)}
          </span>
        </div>
      </Card>
    </Link>
  );
}

function ServerResults({ query }) {
  const { t } = useI18n();
  const [state, setState] = useState({ loading: true, data: [], error: null });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api
        .servers(query)
        .then((data) => !cancelled && setState({ loading: false, data, error: null }))
        .catch((error) => !cancelled && setState({ loading: false, data: [], error }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  if (state.error) return <ErrorBox error={state.error} />;
  if (state.loading) return <Spinner />;
  if (!state.data.length) return <EmptyState title={t('apps.noServer')}>{t('apps.noServerText')}</EmptyState>;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
      {state.data.map((s) => (
        <Card key={s.id} className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
              <ServerIcon />
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-medium">{s.name}</div>
              <div className="text-sm text-slate-500">{[s.attrs.ip, s.attrs.os, s.attrs.environment].filter(Boolean).join(' · ') || '—'}</div>
            </div>
          </div>
          <div className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">{t('apps.hosted')}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {s.applications.length ? (
              s.applications.map((a) => (
                <Link key={a.id} to={`/app/${encodeURIComponent(a.id)}`} className="rounded-lg border border-slate-200 px-2.5 py-1 text-sm hover:border-blue-300 hover:bg-blue-50">
                  {a.name}
                </Link>
              ))
            ) : (
              <span className="text-sm text-slate-400">{t('apps.noHosted')}</span>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function ApplicationsPage() {
  const { t } = useI18n();
  const { data: apps, error, loading, reload } = useApi(() => api.applications(), []);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('app');
  const [level, setLevel] = useState('all');
  const [scope, setScope] = useState('perimeter');

  // périmètre défini (config/perimeter.json) : on montre d'abord les applications suivies
  const perimeterCount = useMemo(() => (apps || []).filter((a) => a.inPerimeter).length, [apps]);
  const base = useMemo(() => (perimeterCount && scope === 'perimeter' ? (apps || []).filter((a) => a.inPerimeter) : apps || []), [apps, perimeterCount, scope]);

  const counts = useMemo(() => {
    const c = { all: base.length, critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    for (const a of base) c[normalizeCriticality(a.criticality)]++;
    return c;
  }, [base]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return base
      .filter((a) => level === 'all' || normalizeCriticality(a.criticality) === level)
      .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.owner || '').toLowerCase().includes(q))
      .sort((a, b) => CRITICALITY[normalizeCriticality(a.criticality)].rank - CRITICALITY[normalizeCriticality(b.criticality)].rank || a.name.localeCompare(b.name));
  }, [base, query, level]);

  return (
    <div className="mx-auto max-w-[1500px]">
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">{t('apps.title')}</h1>
      <p className="mt-2 text-lg text-slate-500">{t('apps.subtitle')}</p>

      <div className="mt-8 grid grid-cols-2 gap-5 xl:grid-cols-4">
        <StatCard value={counts.all} label={t('apps.total')} />
        <StatCard value={counts.critical} label={t('apps.critical')} accent="red" />
        <StatCard value={counts.high} label={t('apps.high')} accent="orange" />
        <StatCard value={counts.medium} label={t('apps.medium')} accent="amber" />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <label className="relative min-w-[280px] max-w-xl flex-1">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'app' ? t('apps.searchApp') : t('apps.searchServer')}
            className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-12 pr-4 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'app', label: t('apps.modeApp') },
            { value: 'server', label: t('apps.modeServer') },
          ]}
        />
        {mode === 'app' && perimeterCount > 0 && (
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'perimeter', label: t('apps.scopePerimeter'), count: perimeterCount },
              { value: 'all', label: t('apps.scopeAll'), count: apps.length },
            ]}
          />
        )}
        {mode === 'app' && (
          <Segmented
            value={level}
            onChange={setLevel}
            options={[
              { value: 'all', label: t('apps.levelAll'), count: counts.all },
              ...LEVELS.map((l) => ({ value: l, label: criticalityLabel(l), count: counts[l] })),
            ]}
          />
        )}
      </div>

      <div className="mt-6 pb-24">
        {mode === 'server' ? (
          <ServerResults query={query} />
        ) : error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading ? (
          <Spinner />
        ) : !apps.length ? (
          <EmptyState title={t('apps.empty')}>{t('apps.emptyText')}</EmptyState>
        ) : !filtered.length ? (
          <EmptyState title={t('apps.noResult')}>{t('apps.noResultText')}</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            {filtered.map((a) => (
              <AppCard key={a.id} app={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
