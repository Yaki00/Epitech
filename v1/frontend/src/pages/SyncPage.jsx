import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { formatDateTime, timeAgo } from '../lib/format';
import { Card, EmptyState, ErrorBox, Spinner, StatCard } from '../components/ui';
import { ChevronIcon, SyncIcon } from '../components/Icons';
import { useI18n } from '../lib/i18n';

const STATUS = {
  success: 'bg-emerald-50 text-emerald-700',
  partial: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
  running: 'bg-blue-50 text-blue-700',
  skipped: 'bg-slate-100 text-slate-600',
};
const statusOf = (status) => (STATUS[status] ? status : 'running');

const STAT_KEYS = ['applications', 'summarized', 'unchanged', 'withoutPages', 'rows', 'nodes', 'relations', 'pages', 'skipped', 'errors', 'mentions', 'diagramLinks', 'llmRelations', 'unresolved', 'outOfScope', 'inScope', 'triaged', 'llmDropped', 'llmRenamed', 'architecturePages'];

/** Nom d'une source de synchro, traduit (valeur brute si inconnue). */
function useSourceName() {
  const { t } = useI18n();
  return (s) => (t(`runSource.${s}`) === `runSource.${s}` ? s : t(`runSource.${s}`));
}

function RunRow({ run }) {
  const { t } = useI18n();
  const sourceName = useSourceName();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState(null);
  const st = statusOf(run.status);
  const stats = Object.entries(run.stats || {}).filter(([k, v]) => STAT_KEYS.includes(k) && typeof v === 'number');
  // pour un inventaire, "skipped" = lignes sans clé ; pour Confluence = pages inchangées
  const statLabel = (k) => (k === 'skipped' && !String(run.source).startsWith('confluence') ? t('stat.skippedRows') : t(`stat.${k}`));

  async function toggle() {
    setOpen((o) => !o);
    if (!errors) setErrors(await api.syncErrors(run.id).catch(() => []));
  }

  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={toggle}>
        <td className="px-5 py-3">
          <ChevronIcon width={16} height={16} className={`text-slate-400 transition ${open ? 'rotate-90' : ''}`} />
        </td>
        <td className="px-5 py-3 font-medium">{sourceName(run.source)}</td>
        <td className="px-5 py-3">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS[st]}`}>{t(`status.${st}`)}</span>
        </td>
        <td className="px-5 py-3 text-slate-600" title={formatDateTime(run.started_at)}>
          {timeAgo(run.started_at)}
        </td>
        <td className="px-5 py-3 text-slate-600">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {stats.map(([k, v]) => (
              <span key={k} className={`whitespace-nowrap ${k === 'errors' && v ? 'font-medium text-red-600' : ''}`}>
                {v} {statLabel(k)}
              </span>
            ))}
          </div>
          {run.error && <div className="mt-1 text-red-600">{run.error}</div>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-12 py-3">
            {!errors ? (
              <span className="text-sm text-slate-500">{t('common.loading')}</span>
            ) : !errors.length ? (
              <span className="text-sm text-slate-500">{t('sync.noErrors')}</span>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                {errors.map((e) => (
                  <li key={e.id} className="text-slate-700">
                    <span className="text-slate-400">[{e.step}]</span> {e.ref && <b>{e.ref}</b>} : {e.message}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

const STEP_ICON = { running: '…', success: '✓', error: '✗' };

/** Boutons de lancement des synchros et journal en direct de la synchro en cours. */
function SyncLauncher({ onFinished }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const logRef = useRef(null);
  const wasRunning = useRef(false);
  const running = state?.current?.status === 'running';

  const refresh = () =>
    api.syncJobs().then(
      (s) => {
        setState(s);
        setError(null);
      },
      (e) => setError(e.message)
    );

  useEffect(() => {
    refresh();
  }, []);
  // pendant une synchro : rafraîchissement toutes les 2 s ; à la fin, l'historique est rechargé
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      onFinished();
    }
    if (!running) return undefined;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.current?.lines?.length]);

  async function launch(job) {
    setError(null);
    try {
      setState(await api.startSyncJob(job));
    } catch (e) {
      // 409 : une autre synchro tourne déjà ; le message du serveur est en français, on l'écrit dans la langue choisie
      setError(e.status === 409 && state?.current ? t('sync.alreadyRunning', { label: t(`job.${state.current.job}`) }) : e.message);
      refresh();
    }
  }

  if (!state) return null;
  if (!state.enabled) {
    return <p className="mt-8 text-sm text-slate-500">{t('sync.disabled')}</p>;
  }
  const cur = state.current;
  const curStatus = cur ? statusOf(cur.status) : null;
  return (
    <Card className="mt-8 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('sync.launch')}</h2>
          <p className="text-sm text-slate-500">{t('sync.launchHelp')}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {state.jobs.map((j) => (
          <button
            key={j.id}
            disabled={running}
            onClick={() => launch(j.id)}
            className={`rounded-xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
              j.id === 'all' ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700' : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              <SyncIcon width={16} height={16} /> {t(`job.${j.id}`)}
            </div>
            <div className={`mt-1 text-xs ${j.id === 'all' ? 'text-blue-100' : 'text-slate-500'}`}>{t(`job.${j.id}.help`)}</div>
          </button>
        ))}
      </div>
      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
      {cur && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{t(`job.${cur.job}`)}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS[curStatus]}`}>{t(`status.${curStatus}`)}</span>
            <span className="text-slate-500" title={formatDateTime(cur.startedAt)}>
              {t('sync.started', { when: timeAgo(cur.startedAt) })}
            </span>
            {running && <span className="text-slate-500">{t('sync.blocked')}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {cur.steps.map((st, i) => (
              <span key={i} className={st.status === 'error' ? 'text-red-600' : st.status === 'success' ? 'text-emerald-700' : ''}>
                {STEP_ICON[st.status]} {st.name}
              </span>
            ))}
          </div>
          <pre ref={logRef} className="mt-3 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
            {cur.lines.join('\n') || t('sync.starting')}
          </pre>
        </div>
      )}
    </Card>
  );
}

export default function SyncPage() {
  const { t } = useI18n();
  const sourceName = useSourceName();
  const { data: runs, error, loading, reload } = useApi(() => api.syncRuns(), []);
  const { data: health, reload: reloadHealth } = useApi(() => api.health(), []);

  const lastBySource = {};
  for (const r of runs || []) if (!lastBySource[r.source]) lastBySource[r.source] = r;

  return (
    <div className="mx-auto max-w-[1500px] pb-24">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">{t('sync.title')}</h1>
          <p className="mt-2 text-lg text-slate-500">{t('sync.subtitle')}</p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium hover:bg-slate-50">
          <SyncIcon width={16} height={16} /> {t('sync.refresh')}
        </button>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-5 xl:grid-cols-4">
        <StatCard value={health?.counts?.application ?? 0} label={t('sync.stat.applications')} />
        <StatCard value={health?.counts?.server ?? 0} label={t('sync.stat.servers')} />
        <StatCard value={health?.counts?.database ?? 0} label={t('sync.stat.databases')} />
        <StatCard value={health?.counts?.document ?? 0} label={t('sync.stat.pages')} />
      </div>

      <SyncLauncher
        onFinished={() => {
          reload();
          reloadHealth && reloadHealth();
        }}
      />

      {Object.keys(lastBySource).length > 0 && (
        <div className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {Object.values(lastBySource).map((r) => {
            const st = statusOf(r.status);
            return (
              <Card key={r.source} className="p-5">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{sourceName(r.source)}</div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS[st]}`}>{t(`status.${st}`)}</span>
                </div>
                <div className="mt-2 text-sm text-slate-500">{t('sync.lastRun', { when: timeAgo(r.finished_at || r.started_at) })}</div>
              </Card>
            );
          })}
        </div>
      )}

      <h2 className="mt-10 text-xl font-semibold">{t('sync.history')}</h2>
      <div className="mt-4">
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading ? (
          <Spinner />
        ) : !runs.length ? (
          <EmptyState title={t('sync.empty')}>{t('sync.emptyText')}</EmptyState>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-5 py-3" />
                  <th className="px-5 py-3 font-medium">{t('sync.col.source')}</th>
                  <th className="px-5 py-3 font-medium">{t('sync.col.status')}</th>
                  <th className="px-5 py-3 font-medium">{t('sync.col.start')}</th>
                  <th className="px-5 py-3 font-medium">{t('sync.col.result')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
