/**
 * Accueil : santé du périmètre, alertes en cours, applications à risque, fraîcheur des sources,
 * derniers changements, applications les moins documentées, écarts avec la supervision.
 * Données : /api/overview, relu toutes les minutes.
 */
import { Link } from 'react-router';
import { Activity, AppWindow, ArrowRight, BellRing, RefreshCw, Server, ShieldAlert } from 'lucide-react';
import { api, REFRESH_MS, useApi, type Overview } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { useConfig } from '../lib/config';
import { bySeverity } from '../lib/status';
import { formatDateTime, relativeTime } from '../lib/format';
import { appHref, serverHref } from '../lib/links';
import { sourceLabel, sourceStatus } from '../lib/sources';
import { cn } from '../lib/cn';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, ScoreMeter, Skeleton, SkeletonRows, Stat, StatusPill } from '../components/ui';
import { AppPath } from '../components/AppPath';
import { ChangeHeader, changeSummary } from '../components/ChangeEntry';

/** Nombre d'alertes listées sur l'accueil ; la suite est sur la page Supervision. */
const MAX_ALERTS = 8;

export default function HomePage() {
  const { t } = useI18n();
  useTitle(t('page.home.title'));
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.overview({ signal }), [], { refreshMs: REFRESH_MS });

  return (
    <>
      <PageHeader
        title={t('page.home.title')}
        subtitle={t('page.home.subtitle')}
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reload} disabled={loading || refreshing} className={refreshing ? '[&>svg]:animate-spin' : undefined}>
            {t('common.refresh')}
          </Button>
        }
      />
      {error && data && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      {loading ? <HomeSkeleton /> : !data ? <ErrorState error={error} onRetry={reload} retrying={refreshing} /> : <HomeContent data={data} />}
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-lg" />
        ))}
      </div>
      <div className="rounded-lg border border-line bg-surface">
        <SkeletonRows rows={8} />
      </div>
    </div>
  );
}

function HomeContent({ data }: { data: Overview }) {
  const { t } = useI18n();
  const naemonOff = data.naemon.source === 'off';
  const unacked = data.alerts.filter((a) => !a.ack).length;
  const acked = data.alerts.length - unacked;
  const byEnv = data.counts.serversByEnv;
  const envHint = [
    `${t('env.short.PRD')} ${byEnv.PRD}`,
    `${t('env.short.STG')} ${byEnv.STG}`,
    `${t('env.short.DEV')} ${byEnv.DEV}`,
    ...(byEnv.unspecified ? [`${t('env.short.none')} ${byEnv.unspecified}`] : []),
  ].join(', ');

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('home.stat.apps')}
          value={data.counts.applications}
          icon={AppWindow}
          to="/applications?scope=in"
          hint={data.atRisk.length ? t('home.stat.appsHint', { n: data.atRisk.length }) : undefined}
        />
        <Stat label={t('home.stat.servers')} value={data.counts.servers} icon={Server} to="/servers" hint={envHint} />
        <Stat
          label={t('home.stat.alerts')}
          value={naemonOff ? null : unacked}
          unavailable={t('common.notConnected')}
          icon={BellRing}
          tone={!naemonOff && unacked > 0 ? 'down' : undefined}
          to="/monitoring"
          hint={acked ? t('home.stat.alertsHint', { n: acked }) : undefined}
        />
        <Stat
          label={t('home.stat.atRisk')}
          value={naemonOff ? null : data.atRisk.length}
          unavailable={t('common.notConnected')}
          icon={ShieldAlert}
          tone={!naemonOff && data.atRisk.length > 0 ? 'warn' : undefined}
          hint={t('home.stat.atRiskHint')}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <HealthCard data={data} />
          <AlertsCard data={data} />
          <RiskCard data={data} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SourcesCard data={data} />
          <GapsCard data={data} />
          <LowestDocsCard data={data} />
          <ChangesCard data={data} />
        </div>
      </div>
    </div>
  );
}

function HealthCard({ data }: { data: Overview }) {
  const { t } = useI18n();
  const atRisk = new Set(data.atRisk.map((r) => r.appId));
  const apps = [...data.apps].sort((a, b) => bySeverity(a.state, b.state) || Number(atRisk.has(b.id)) - Number(atRisk.has(a.id)) || a.name.localeCompare(b.name));
  return (
    <Card title={t('home.health.title')} description={t('home.health.desc')} actions={<Button size="sm" variant="ghost" to="/applications" icon={ArrowRight}>{t('nav.applications')}</Button>}>
      {apps.length === 0 ? (
        <EmptyState compact icon={AppWindow} title={t('home.health.empty')} text={t('home.health.emptyText')} />
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
          {apps.map((a) => (
            <li key={a.id}>
              <Link
                to={appHref(a.id)}
                className="flex h-full flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={a.name}>
                    {a.name}
                  </span>
                  <StatusPill state={a.state} size="sm" />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {a.criticality && <Badge title={t('apps.col.criticality')}>{a.criticality}</Badge>}
                    {atRisk.has(a.id) && (
                      <Badge tone="warn" icon={ShieldAlert}>
                        {t('state.atRisk')}
                      </Badge>
                    )}
                  </div>
                  <ScoreMeter score={a.docScore} label={t('common.docScore')} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AlertsCard({ data }: { data: Overview }) {
  const { t } = useI18n();
  const off = data.naemon.source === 'off';
  // non prises en charge d'abord (le serveur trie déjà ; on garde l'ordre si égal)
  const alerts = [...data.alerts].sort((a, b) => Number(a.ack) - Number(b.ack));
  const shown = alerts.slice(0, MAX_ALERTS);
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          {t('home.alerts.title')}
          {!off && <span className="tabular rounded-sm bg-surface-3 px-1 text-2xs text-ink-2">{alerts.length}</span>}
        </span>
      }
      description={!off && alerts.length > 0 ? t('home.alerts.desc') : undefined}
      actions={<Button size="sm" variant="ghost" to="/monitoring" icon={ArrowRight}>{t('nav.monitoring')}</Button>}
      padded={false}
    >
      {off ? (
        <EmptyState compact icon={Activity} title={t('common.monitoringOff')} text={t('common.monitoringOffText')} />
      ) : alerts.length === 0 ? (
        <EmptyState compact icon={BellRing} title={t('home.alerts.empty')} text={t('home.alerts.emptyText')} />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {shown.map((a) => (
              <li key={a.serverId} className={cn('flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3', a.ack && 'bg-surface-2/50')}>
                <div className="shrink-0 sm:w-44">
                  <StatusPill state={a.state} size="sm" ack={a.ack} />
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={serverHref(a.serverId)} className="link font-mono text-xs font-medium">
                    {a.name}
                  </Link>
                  <p className="truncate text-xs text-ink-2" title={a.output}>
                    {a.output}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs sm:max-w-[40%] sm:justify-end">
                  {a.apps.length === 0 ? (
                    <span className="text-ink-3">{t('common.none')}</span>
                  ) : (
                    a.apps.map((app) => (
                      <Link key={app.id} to={appHref(app.id)} className="link">
                        {app.name}
                      </Link>
                    ))
                  )}
                </div>
              </li>
            ))}
          </ul>
          {alerts.length > shown.length && (
            <div className="border-t border-line px-4 py-2 text-xs">
              <Link to="/monitoring" className="link">
                {t('home.alerts.more', { n: alerts.length - shown.length })}
              </Link>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function RiskCard({ data }: { data: Overview }) {
  const { t } = useI18n();
  const off = data.naemon.source === 'off';
  const stateOf = new Map(data.apps.map((a) => [a.id, a.state]));
  return (
    <Card title={t('home.risk.title')} description={t('home.risk.desc')} padded={false}>
      {off ? (
        <EmptyState compact icon={Activity} title={t('common.monitoringOff')} text={t('common.monitoringOffText')} />
      ) : data.atRisk.length === 0 ? (
        <EmptyState compact icon={ShieldAlert} title={t('home.risk.empty')} text={t('home.risk.emptyText')} />
      ) : (
        <ul className="divide-y divide-line">
          {data.atRisk.map((r) => (
            <li key={r.appId} className="flex flex-col gap-1.5 px-4 py-2.5 md:flex-row md:items-center md:gap-3">
              <div className="flex min-w-0 items-center gap-2 md:w-64 md:shrink-0">
                <ShieldAlert aria-hidden size={15} className="shrink-0 text-warn" />
                <Link to={appHref(r.appId)} className="link truncate text-[13px] font-medium">
                  {r.name}
                </Link>
                <span className="shrink-0 text-xs text-ink-3">{t('home.risk.dependsOn')}</span>
              </div>
              <AppPath path={r.path.slice(1)} label={t('appDetail.atRisk.path')} failingState={stateOf.get(r.because.id) ?? 'down'} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SourcesCard({ data }: { data: Overview }) {
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const rows = data.sources.map((s) => ({ key: s.source, label: sourceLabel(t, s.source), lastRun: s.lastRun, status: sourceStatus(t, s.status), connected: true }));
  // ServiceNow et Bitbucket : « Non connecté » tant que la source n'est pas branchée (jamais un 0 trompeur)
  for (const extra of ['servicenow', 'bitbucket'] as const) {
    if (rows.some((r) => r.key === extra)) continue;
    const connected = Boolean(config?.sources?.[extra]);
    rows.push({ key: extra, label: sourceLabel(t, extra), lastRun: null, status: connected ? sourceStatus(t, 'pending') : { label: t('common.notConnected'), tone: 'neutral' }, connected });
  }
  return (
    <Card title={t('home.sources.title')} padded={false}>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 px-4 py-2">
            <span className={cn('min-w-0 flex-1 truncate text-[13px]', r.connected ? 'text-ink' : 'text-ink-3')}>{r.label}</span>
            {r.connected && (
              <span className="text-xs whitespace-nowrap text-ink-3" title={r.lastRun ? formatDateTime(r.lastRun, lang) : undefined}>
                {relativeTime(r.lastRun, lang)}
              </span>
            )}
            <Badge tone={r.status.tone}>{r.status.label}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GapsCard({ data }: { data: Overview }) {
  const { t } = useI18n();
  const { counts, available } = data.gaps;
  const rows: { key: keyof typeof counts; label: string; needsPoll: boolean }[] = [
    { key: 'notMonitored', label: t('home.gaps.notMonitored'), needsPoll: true },
    { key: 'unknownMonitored', label: t('home.gaps.unknownMonitored'), needsPoll: true },
    { key: 'citedNotInInventory', label: t('home.gaps.citedNotInInventory'), needsPoll: false },
  ];
  return (
    <Card title={t('home.gaps.title')} description={available ? undefined : t('home.gaps.unavailable')} padded={false}>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const missing = r.needsPoll && !available;
          const n = counts[r.key];
          return (
            <li key={r.key}>
              <Link to="/monitoring" className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2">
                <span className="min-w-0 flex-1 text-[13px] text-ink-2">{r.label}</span>
                {missing ? (
                  <span className="text-xs text-ink-3">{t('common.unavailable')}</span>
                ) : (
                  <span className={cn('tabular text-[15px] font-semibold', n > 0 ? 'text-warn' : 'text-ink')}>{n}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function LowestDocsCard({ data }: { data: Overview }) {
  const { t } = useI18n();
  return (
    <Card title={t('home.docs.title')} padded={false}>
      {data.lowestDocs.length === 0 ? (
        <EmptyState compact title={t('home.docs.empty')} />
      ) : (
        <ul className="divide-y divide-line">
          {data.lowestDocs.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2">
              <Link to={`${appHref(a.id)}?tab=docs`} className="link min-w-0 flex-1 truncate text-[13px]">
                {a.name}
              </Link>
              <ScoreMeter score={a.docScore} label={t('common.docScore')} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChangesCard({ data }: { data: Overview }) {
  const { t } = useI18n();
  return (
    <Card title={t('home.changes.title')} actions={<Button size="sm" variant="ghost" to="/history" icon={ArrowRight}>{t('home.changes.seeAll')}</Button>} padded={false}>
      {data.recentChanges.length === 0 ? (
        <EmptyState compact title={t('changes.empty')} text={t('changes.emptyText')} />
      ) : (
        <ul className="divide-y divide-line">
          {data.recentChanges.slice(0, 5).map((c, i) => (
            <li key={`${c.at}-${c.source}-${i}`} className="flex flex-col gap-1 px-4 py-2.5">
              <ChangeHeader change={c} />
              <p className="text-xs text-ink-2">{changeSummary(t, c)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
