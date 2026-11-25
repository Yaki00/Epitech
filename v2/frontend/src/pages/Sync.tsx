/**
 * Synchronisation : lancement des synchros (Confluence, APM, marketplace, tout), journal de la synchro
 * en cours, historique des passages avec leurs erreurs, dernier passage par source, relève Naemon.
 * Boutons coupés en mode démo (« mode démo ») et quand le serveur interdit le lancement (ALLOW_UI_SYNC=false).
 * Données : /api/sync/jobs (relu toutes les 2 s pendant une synchro), /api/sync/runs, /api/sync/runs/:id/errors.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleAlert, FlaskConical, Loader, Lock, Play, RefreshCw, X } from 'lucide-react';
import { ApiError, api, useApi, type SyncJobs, type SyncRun, type SyncRunError } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { useConfig } from '../lib/config';
import { formatDateTime, relativeTime } from '../lib/format';
import { sourceLabel } from '../lib/sources';
import { confluenceFetchOff, jobHelpKey, jobsToShow, lastRunBySource, launchBlocked, notReadPages, runEnded, runStarted, runStats, runStatus, statKey, type RunStatus } from '../lib/sync';
import { invalidateTeamsCache } from '../lib/teamsCache';
import { cn } from '../lib/cn';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonRows, type BadgeTone } from '../components/ui';
import { NaemonStatusCard } from '../components/NaemonStatus';

const STATUS_TONE: Record<RunStatus, BadgeTone> = { success: 'ok', partial: 'warn', error: 'down', running: 'accent', skipped: 'neutral' };
/** Intervalle de relecture pendant une synchro. */
const POLL_MS = 2000;

function RunBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const s = runStatus(status);
  return <Badge tone={STATUS_TONE[s]}>{t(`sync.status.${s}` as Key)}</Badge>;
}

const jobLabel = (t: (k: Key) => string, job: { id: string; label: string }) => {
  const key = `sync.job.${job.id}` as Key;
  const text = t(key);
  return text === key ? job.label : text;
};

export default function SyncPage() {
  const { t } = useI18n();
  useTitle(t('page.sync.title'));
  const runs = useApi((signal) => api.syncRuns(50, { signal }), []);

  return (
    <>
      <PageHeader
        title={t('page.sync.title')}
        subtitle={t('page.sync.subtitle')}
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={runs.reload} disabled={runs.loading || runs.refreshing} className={runs.refreshing ? '[&>svg]:animate-spin' : undefined}>
            {t('common.refresh')}
          </Button>
        }
      />
      <NotReadNotice runs={runs.data} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <LauncherCard onFinished={runs.reload} />
          <RunsCard runs={runs.data} error={runs.error} loading={runs.loading} refreshing={runs.refreshing} reload={runs.reload} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <NaemonStatusCard />
          <SourcesCard runs={runs.data} />
        </div>
      </div>
    </>
  );
}

/** Avertissement : des pages du dernier passage Confluence n'ont pas été lues par l'IA (rien n'en est déduit). */
function NotReadNotice({ runs }: { runs: SyncRun[] | null }) {
  const { t } = useI18n();
  const n = notReadPages(runs ?? []);
  if (!n) return null;
  return (
    <p role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-ink">
      <CircleAlert aria-hidden size={16} className="mt-px shrink-0 text-warn" />
      {t('sync.notRead', { n })}
    </p>
  );
}

// ---------- lancement ----------

function useSyncJobs(onFinished: () => void) {
  const [state, setState] = useState<SyncJobs | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const wasRunning = useRef(false);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const running = state?.current?.status === 'running';

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      api.syncJobs({ signal }).then(
        (s) => {
          setState(s);
          setError(null);
        },
        (e: unknown) => {
          if (signal?.aborted) return;
          setError(e instanceof Error ? e : new Error(String(e)));
        },
      ),
    [],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    return () => ctrl.abort();
  }, [refresh]);

  // pendant une synchro : relecture toutes les 2 s ; à la fin, l'historique des passages est relu
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      invalidateTeamsCache(); // responsables et équipes changés par la synchro : la palette Ctrl+K les relira
      finishedRef.current();
    }
    if (!running) return undefined;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [running, refresh]);

  return { state, setState, error, setError, refresh, running };
}

function LauncherCard({ onFinished }: { onFinished: () => void }) {
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const { state, setState, error, setError, refresh, running } = useSyncJobs(onFinished);
  const [starting, setStarting] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const blocked = launchBlocked(Boolean(config?.demo), state);
  const jobs = jobsToShow(state);
  const cur = state?.current ?? null;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [cur?.lines.length]);

  async function launch(job: string) {
    setError(null);
    setStarting(job);
    try {
      setState(await api.startSyncJob(job));
    } catch (e) {
      // 409 : une autre synchro tourne déjà (message du serveur en français : on l'écrit dans la langue choisie)
      const busy = e instanceof ApiError && e.status === 409 && cur;
      setError(busy ? new Error(t('sync.alreadyRunning', { label: jobLabel(t, { id: cur.job, label: cur.label }) })) : e instanceof Error ? e : new Error(String(e)));
      void refresh();
    } finally {
      setStarting(null);
    }
  }

  return (
    <Card
      title={t('sync.launch.title')}
      description={t('sync.launch.desc')}
      actions={
        blocked === 'demo' ? (
          <Badge tone="accent" icon={FlaskConical}>
            {t('sync.demoBadge')}
          </Badge>
        ) : blocked === 'disabled' ? (
          <Badge icon={Lock}>{t('sync.disabledBadge')}</Badge>
        ) : undefined
      }
    >
      {blocked && (
        <p role="note" className="mb-3 flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          {blocked === 'demo' ? <FlaskConical aria-hidden size={14} className="mt-px shrink-0" /> : <Lock aria-hidden size={14} className="mt-px shrink-0" />}
          <span>{blocked === 'demo' ? t('sync.demo') : t('sync.disabled')}</span>
        </p>
      )}
      {!state && !error ? (
        <SkeletonRows rows={2} />
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {jobs.map((j) => {
            const help = jobHelpKey(j);
            const primary = j.id === 'all';
            // état des tâches illisible : rien n'est lancé à l'aveugle
            const disabled = !state || Boolean(blocked) || running || starting !== null;
            const fetchOff = j.id === 'confluence' && confluenceFetchOff(j.description);
            return (
              <li key={j.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void launch(j.id)}
                  className={cn(
                    'flex h-full w-full flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed',
                    primary ? 'border-accent/50 bg-accent-soft hover:bg-accent-soft/70' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2',
                    disabled && 'opacity-60 hover:bg-transparent',
                  )}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {starting === j.id ? (
                      <Loader aria-hidden size={14} className="animate-spin text-accent" />
                    ) : (
                      <Play aria-hidden size={14} className={primary ? 'text-accent' : 'text-ink-3'} />
                    )}
                    <span className={cn('text-[13px] font-medium', primary ? 'text-accent' : 'text-ink')}>{jobLabel(t, j)}</span>
                    {fetchOff && <Badge>{t('sync.job.readOnlyExport')}</Badge>}
                    {blocked === 'demo' && <span className="text-2xs text-ink-3">({t('sync.demoMention')})</span>}
                  </span>
                  <span className="text-xs text-ink-2">{help ? t(help) : j.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-xs text-down">
          <CircleAlert aria-hidden size={14} className="mt-px shrink-0" />
          {error.message}
        </p>
      )}
      {cur && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium text-ink">{jobLabel(t, { id: cur.job, label: cur.label })}</span>
            <RunBadge status={cur.status} />
            <span className="text-xs text-ink-3" title={formatDateTime(cur.startedAt, lang)}>
              {t('sync.current.started', { when: relativeTime(cur.startedAt, lang) })}
            </span>
            {running && <span className="text-xs text-ink-3">{t('sync.current.blocked')}</span>}
          </div>
          {cur.steps.length > 0 && (
            <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {cur.steps.map((st, i) => (
                <li key={`${st.name}-${i}`} className={cn('inline-flex items-center gap-1 font-mono', st.status === 'error' ? 'text-down' : st.status === 'success' ? 'text-ok' : 'text-ink-2')}>
                  {st.status === 'success' ? <Check aria-hidden size={12} /> : st.status === 'error' ? <X aria-hidden size={12} /> : <Loader aria-hidden size={12} className="animate-spin" />}
                  <span className="sr-only">{t(`sync.status.${runStatus(st.status)}` as Key)}</span>
                  {st.name}
                </li>
              ))}
            </ol>
          )}
          <pre
            ref={logRef}
            aria-label={t('sync.current.log')}
            tabIndex={0}
            className="mt-2 max-h-72 overflow-auto rounded-md bg-[#0f172a] p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-slate-100"
          >
            {cur.lines.join('\n') || t('sync.current.starting')}
          </pre>
        </div>
      )}
    </Card>
  );
}

// ---------- passages ----------

function RunsCard({ runs, error, loading, refreshing, reload }: { runs: SyncRun[] | null; error: Error | null; loading: boolean; refreshing: boolean; reload: () => void }) {
  const { t } = useI18n();
  const { config } = useConfig();
  return (
    <Card title={t('sync.runs.title')} description={runs?.length ? t('sync.runs.desc') : undefined} padded={false}>
      {error && runs && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="m-3" />}
      {loading ? (
        <SkeletonRows rows={6} />
      ) : !runs ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={reload} retrying={refreshing} />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState icon={RefreshCw} title={t('sync.runs.empty')} text={config?.demo ? t('sync.runs.emptyDemo') : t('sync.runs.emptyText')} />
      ) : (
        <>
          <div aria-hidden className="hidden border-b border-line bg-surface-2 px-4 py-2 text-xs font-medium text-ink-3 md:flex md:gap-4">
            <span className="w-48 shrink-0 pl-6">{t('sync.col.source')}</span>
            <span className="w-24 shrink-0">{t('sync.col.status')}</span>
            <span className="w-28 shrink-0">{t('sync.col.start')}</span>
            <span className="flex-1">{t('sync.col.result')}</span>
          </div>
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function RunRow({ run }: { run: SyncRun }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<SyncRunError[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const stats = runStats(run);
  const started = runStarted(run);
  const panelId = `run-${run.id}-errors`;

  const toggle = () => {
    setOpen((o) => !o);
    if (errors || open) return;
    setLoadError(null);
    api.syncErrors(run.id).then(setErrors, (e: unknown) => setLoadError(e instanceof Error ? e : new Error(String(e))));
  };

  return (
    <li>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full flex-col gap-1.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 md:flex-row md:items-start md:gap-4"
      >
        <span className="flex min-w-0 items-center gap-2 md:w-48 md:shrink-0">
          <ChevronRight aria-hidden size={15} className={cn('shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
          <span className="truncate text-[13px] font-medium text-ink">{sourceLabel(t, run.source)}</span>
        </span>
        <span className="flex items-center gap-3 pl-6 md:contents md:pl-0">
          <span className="md:w-24 md:shrink-0">
            <RunBadge status={run.status} />
          </span>
          <span className="text-xs whitespace-nowrap text-ink-2 md:w-28 md:shrink-0" title={started ? formatDateTime(started, lang) : undefined}>
            {relativeTime(started, lang)}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 pl-6 md:pl-0">
          {stats.length > 0 ? (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-2">
              {stats.map(([k, v]) => (
                <span key={k} className={cn('whitespace-nowrap', k === 'errors' && v > 0 && 'font-medium text-down')}>
                  <span className="tabular">{v}</span> {t(statKey(run.source, k))}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-xs text-ink-3">{t('common.none')}</span>
          )}
          {run.error && <span className="text-xs break-words text-down">{run.error}</span>}
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-line bg-surface-2/50 px-4 py-3 md:pl-10">
          <p className="mb-1.5 text-2xs text-ink-3">
            {t('sync.runs.ended', { when: formatDateTime(runEnded(run), lang) })}
          </p>
          {loadError ? (
            <p className="text-xs text-down">{loadError.message}</p>
          ) : !errors ? (
            <p className="text-xs text-ink-3">{t('common.loading')}</p>
          ) : errors.length === 0 ? (
            <p className="text-xs text-ink-2">{t('sync.runs.noErrors')}</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto font-mono text-2xs text-ink-2">
              {errors.map((e, i) => (
                <li key={`${e.step}-${e.ref ?? ''}-${i}`} className="break-words">
                  <span className="text-ink-3">[{e.step}]</span> {e.ref && <b className="text-ink">{e.ref}</b>}
                  {t('common.colon')} {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ---------- sources ----------

function SourcesCard({ runs }: { runs: SyncRun[] | null }) {
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const last = lastRunBySource(runs ?? []);
  return (
    <Card title={t('sync.sources.title')} padded={false}>
      <ul className="divide-y divide-line">
        {last.map((r) => {
          const when = runEnded(r);
          return (
            <li key={r.source} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{sourceLabel(t, r.source)}</span>
              <span className="text-xs whitespace-nowrap text-ink-3" title={when ? formatDateTime(when, lang) : undefined}>
                {relativeTime(when, lang)}
              </span>
              <RunBadge status={r.status} />
            </li>
          );
        })}
        {last.length === 0 && <li className="px-4 py-2 text-xs text-ink-3">{config?.demo ? t('sync.sources.demo') : t('sync.sources.none')}</li>}
        {/* ServiceNow et Bitbucket : « Non connecté » tant que la source n'est pas branchée (jamais un 0 trompeur) */}
        {(['servicenow', 'bitbucket'] as const)
          .filter((s) => !last.some((r) => r.source === s))
          .map((s) => {
            const connected = Boolean(config?.sources?.[s]);
            return (
              <li key={s} className="flex items-center gap-3 px-4 py-2">
                <span className={cn('min-w-0 flex-1 truncate text-[13px]', connected ? 'text-ink' : 'text-ink-3')}>{sourceLabel(t, s)}</span>
                <Badge>{connected ? t('sourceStatus.pending') : t('common.notConnected')}</Badge>
              </li>
            );
          })}
      </ul>
    </Card>
  );
}
