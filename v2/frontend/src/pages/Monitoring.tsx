/**
 * Supervision : alertes en cours sur le périmètre (filtre d'environnements), impact réel (applications
 * en panne ou dégradées, applications à risque), serveurs en maintenance, rapport d'écarts (4 listes + CSV),
 * état de la relève Naemon. Source coupée : chaque zone dit comment la brancher, jamais de zéros.
 * Données : /api/overview et /api/gaps (relus chaque minute), relève partagée /api/status, liste des serveurs.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Activity, AppWindow, BellRing, Download, ExternalLink, EyeOff, FileSearch, RefreshCw, ServerOff, ShieldAlert, ShieldQuestion, Wrench } from 'lucide-react';
import { api, REFRESH_MS, useApi, type Env, type GapToValidate, type Gaps, type Overview, type ServerSummary, type UseApiResult } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { useLiveStatus } from '../lib/live';
import { envVisible, useEnvFilter } from '../lib/envFilter';
import { epochSeconds, formatDateTime, relativeTime } from '../lib/format';
import { alertRows, countByEnv, impactedApps, maintenanceRows, type AlertRow } from '../lib/monitoring';
import { ENVS, severity } from '../lib/status';
import { appHref, serverHref } from '../lib/links';
import { cn } from '../lib/cn';
import { Badge, Button, Card, EmptyState, EnvBadge, ErrorState, PageHeader, Skeleton, SkeletonRows, Stat, StatusPill, Table, Tabs, type Column } from '../components/ui';
import { EnvFilter } from '../components/EnvFilter';
import { AppPath } from '../components/AppPath';
import { NaemonStatusCard } from '../components/NaemonStatus';

/** Liste des serveurs demandée pour connaître leur environnement (même limite que la page Serveurs). */
const SERVERS_LIMIT = 5000;

export default function MonitoringPage() {
  const { t } = useI18n();
  useTitle(t('page.monitoring.title'));
  const overview = useApi((signal) => api.overview({ signal }), [], { refreshMs: REFRESH_MS });
  const gaps = useApi((signal) => api.gaps({ signal }), [], { refreshMs: REFRESH_MS });
  // environnement des serveurs (absent de l'aperçu) et serveurs en maintenance
  const servers = useApi((signal) => api.servers(undefined, SERVERS_LIMIT, { signal }), [], { refreshMs: REFRESH_MS });
  const { reload: reloadLive } = useLiveStatus();
  const busy = overview.refreshing || gaps.refreshing || overview.loading;
  const reloadAll = () => {
    overview.reload();
    gaps.reload();
    servers.reload();
    reloadLive();
  };

  return (
    <>
      <PageHeader
        title={t('page.monitoring.title')}
        subtitle={t('page.monitoring.subtitle')}
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reloadAll} disabled={busy} className={overview.refreshing ? '[&>svg]:animate-spin' : undefined}>
            {t('common.refresh')}
          </Button>
        }
      />
      {overview.error && overview.data && <ErrorState error={overview.error} onRetry={overview.reload} retrying={overview.refreshing} className="mb-4" />}
      {overview.loading ? (
        <MonitoringSkeleton />
      ) : !overview.data ? (
        <ErrorState error={overview.error} onRetry={overview.reload} retrying={overview.refreshing} />
      ) : (
        <MonitoringContent data={overview.data} servers={servers} gaps={gaps} />
      )}
    </>
  );
}

function MonitoringSkeleton() {
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

type ServersResult = UseApiResult<ServerSummary[]>;
type GapsResult = UseApiResult<Gaps>;

function MonitoringContent({ data, servers, gaps }: { data: Overview; servers: ServersResult; gaps: GapsResult }) {
  const { t } = useI18n();
  const { status: live } = useLiveStatus();
  const off = data.naemon.source === 'off';

  const envById = useMemo(() => new Map<string, Env | null>((servers.data ?? []).map((s) => [s.id, s.env])), [servers.data]);
  const alerts = useMemo(() => alertRows(data.alerts, live, envById), [data.alerts, live, envById]);
  const tracked = useMemo(() => new Set(data.apps.map((a) => a.id)), [data.apps]);
  const maintenance = useMemo(() => maintenanceRows(servers.data ?? [], live, tracked), [servers.data, live, tracked]);
  const impacted = impactedApps(data.apps);
  const unacked = alerts.filter((a) => !a.ack).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('monitoring.stat.alerts')}
          value={off ? null : unacked}
          unavailable={t('common.notConnected')}
          icon={BellRing}
          tone={!off && unacked > 0 ? 'down' : undefined}
          hint={!off && alerts.length > unacked ? t('home.stat.alertsHint', { n: alerts.length - unacked }) : undefined}
        />
        <Stat label={t('monitoring.stat.impacted')} value={off ? null : impacted.length} unavailable={t('common.notConnected')} icon={AppWindow} tone={!off && impacted.length > 0 ? 'warn' : undefined} />
        <Stat
          label={t('monitoring.stat.atRisk')}
          value={off ? null : data.atRisk.length}
          unavailable={t('common.notConnected')}
          icon={ShieldAlert}
          tone={!off && data.atRisk.length > 0 ? 'warn' : undefined}
          hint={t('home.stat.atRiskHint')}
        />
        <Stat label={t('monitoring.stat.maintenance')} value={off ? null : maintenance.length} unavailable={t('common.notConnected')} icon={Wrench} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <AlertsCard rows={alerts} off={off} envLoaded={Boolean(servers.data)} />
          <ImpactCard data={data} alerts={alerts} off={off} />
          {!off && maintenance.length > 0 && <MaintenanceCard rows={maintenance} />}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <NaemonStatusCard />
        </div>
      </div>

      <GapsCard gaps={gaps} off={off} />
    </div>
  );
}

// ---------- alertes ----------

function AlertsCard({ rows, off, envLoaded }: { rows: AlertRow[]; off: boolean; envLoaded: boolean }) {
  const { t, lang } = useI18n();
  const [filter] = useEnvFilter();
  const visible = rows.filter((r) => envVisible(filter, r.env));
  const hidden = rows.length - visible.length;

  const columns: Column<AlertRow>[] = [
    {
      key: 'name',
      header: t('servers.col.name'),
      sortValue: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <Link to={serverHref(r.serverId)} className="link font-mono text-xs font-medium whitespace-nowrap">
          {r.name}
        </Link>
      ),
    },
    {
      key: 'env',
      header: t('servers.col.env'),
      sortValue: (r) => {
        const i = ENVS.indexOf(r.env as Env);
        return i < 0 ? ENVS.length : i;
      },
      cell: (r) => <EnvBadge env={r.env} />,
    },
    {
      key: 'state',
      header: t('servers.col.state'),
      // non prises en charge d'abord, puis gravité
      sortValue: (r) => (r.ack ? 10 : 0) - severity(r.state),
      cell: (r) => <StatusPill state={r.state} size="sm" ack={r.ack} />,
    },
    {
      key: 'output',
      header: t('monitoring.col.output'),
      hideOnMobile: true,
      cell: (r) =>
        r.output ? (
          <span className="line-clamp-2 max-w-[28rem] text-xs break-words text-ink-2" title={r.output}>
            {r.output}
          </span>
        ) : (
          <span className="text-xs text-ink-3">{t('common.none')}</span>
        ),
    },
    {
      key: 'check',
      header: t('monitoring.col.check'),
      hideOnMobile: true,
      sortValue: (r) => -(r.lastCheck ?? 0),
      cell: (r) => {
        const d = epochSeconds(r.lastCheck);
        return (
          <span className="text-xs whitespace-nowrap text-ink-2" title={d ? formatDateTime(d, lang) : undefined}>
            {relativeTime(d, lang)}
          </span>
        );
      },
    },
    {
      key: 'apps',
      header: t('servers.col.apps'),
      cell: (r) =>
        r.apps.length === 0 ? (
          <span className="text-xs text-ink-3">{t('common.none')}</span>
        ) : (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5">
            {r.apps.map((a) => (
              <Link key={a.id} to={appHref(a.id)} className="link text-xs">
                {a.name}
              </Link>
            ))}
          </span>
        ),
    },
  ];

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          {t('monitoring.alerts.title')}
          {!off && <span className="tabular rounded-sm bg-surface-3 px-1 text-2xs text-ink-2">{visible.length}</span>}
        </span>
      }
      description={off ? undefined : t('monitoring.alerts.desc')}
      padded={false}
    >
      {off ? (
        <EmptyState icon={Activity} title={t('common.monitoringOff')} text={t('naemon.offText')} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 border-b border-line px-3 py-1">
            <EnvFilter counts={envLoaded ? countByEnv(rows) : undefined} />
            {hidden > 0 && <span className="text-xs text-ink-3">{t('monitoring.alerts.hidden', { n: hidden })}</span>}
          </div>
          {rows.length === 0 ? (
            <EmptyState compact icon={BellRing} title={t('home.alerts.empty')} text={t('home.alerts.emptyText')} />
          ) : (
            <Table
              columns={columns}
              rows={visible}
              rowKey={(r) => r.serverId}
              rowHref={(r) => serverHref(r.serverId)}
              rowMuted={(r) => r.ack}
              defaultSort={{ key: 'state', dir: 'asc' }}
              caption={t('monitoring.alerts.title')}
              empty={<EmptyState compact icon={BellRing} title={t('monitoring.alerts.allHidden')} text={t('monitoring.alerts.allHiddenText')} />}
            />
          )}
        </>
      )}
    </Card>
  );
}

// ---------- impact réel ----------

function ImpactCard({ data, alerts, off }: { data: Overview; alerts: AlertRow[]; off: boolean }) {
  const { t } = useI18n();
  const { status: live } = useLiveStatus();
  const [filter] = useEnvFilter();
  const impacted = impactedApps(data.apps);
  const stateOf = new Map(data.apps.map((a) => [a.id, a.state]));
  const alertCount = (appId: string) => alerts.filter((a) => a.apps.some((x) => x.id === appId)).length;

  return (
    <Card title={t('monitoring.impact.title')} description={t('monitoring.impact.desc')} padded={false}>
      {off ? (
        <EmptyState compact icon={Activity} title={t('common.monitoringOff')} text={t('common.monitoringOffText')} />
      ) : impacted.length === 0 && data.atRisk.length === 0 ? (
        <EmptyState compact icon={ShieldAlert} title={t('monitoring.impact.empty')} text={t('monitoring.impact.emptyText')} />
      ) : (
        <div className="flex flex-col">
          <h3 className="border-b border-line bg-surface-2/60 px-4 py-1.5 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
            {t('monitoring.impact.down', { n: impacted.length })}
          </h3>
          {impacted.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-3">{t('monitoring.impact.noneDown')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {impacted.map((a) => {
                const byEnv = live?.apps[a.id]?.byEnv ?? {};
                const n = alertCount(a.id);
                return (
                  <li key={a.id} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex min-w-0 items-center gap-2 sm:w-56 sm:shrink-0">
                      <Link to={appHref(a.id)} className="link truncate text-[13px] font-medium">
                        {a.name}
                      </Link>
                      {a.criticality && <Badge title={t('apps.col.criticality')}>{a.criticality}</Badge>}
                    </div>
                    <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                      <StatusPill state={a.state} size="sm" />
                      {ENVS.filter((e) => byEnv[e] && filter.envs.includes(e)).map((e) => (
                        <span key={e} className="inline-flex items-center gap-1 text-xs text-ink-2">
                          <span className="font-medium">{t(`env.short.${e}` as 'env.short.PRD')}</span>
                          <StatusPill state={byEnv[e]} size="sm" iconOnly />
                          <span>{t(`state.${byEnv[e]}` as 'state.ok')}</span>
                        </span>
                      ))}
                    </div>
                    {n > 0 && <span className="shrink-0 text-xs text-ink-3">{t('monitoring.impact.alerts', { n })}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <h3 className="border-y border-line bg-surface-2/60 px-4 py-1.5 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
            {t('monitoring.impact.atRisk', { n: data.atRisk.length })}
          </h3>
          {data.atRisk.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-3">{t('home.risk.emptyText')}</p>
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
        </div>
      )}
    </Card>
  );
}

// ---------- maintenance ----------

function MaintenanceCard({ rows }: { rows: ReturnType<typeof maintenanceRows> }) {
  const { t } = useI18n();
  const [filter] = useEnvFilter();
  const visible = rows.filter((r) => envVisible(filter, r.env));
  return (
    <Card title={t('monitoring.maintenance.title')} description={t('monitoring.maintenance.desc')} padded={false}>
      {visible.length === 0 ? (
        <p className="px-4 py-3 text-xs text-ink-3">{t('monitoring.alerts.hidden', { n: rows.length })}</p>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((r) => (
            <li key={r.id} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex shrink-0 items-center gap-2 sm:w-56">
                <StatusPill state="maintenance" size="sm" />
                <EnvBadge env={r.env} />
              </div>
              <div className="min-w-0 flex-1">
                <Link to={serverHref(r.id)} className="link font-mono text-xs font-medium whitespace-nowrap">
                  {r.name}
                </Link>
                {r.output && (
                  <p className="truncate text-xs text-ink-2" title={r.output}>
                    {r.output}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
                {r.apps.map((a) => (
                  <Link key={a.id} to={appHref(a.id)} className="link">
                    {a.name}
                  </Link>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------- rapport d'écarts ----------

type GapTab = 'notMonitored' | 'unknownMonitored' | 'citedNotInInventory' | 'toValidate';

function GapsCard({ gaps, off }: { gaps: GapsResult; off: boolean }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<GapTab>('notMonitored');
  const g = gaps.data;
  // sans relève, les deux listes de supervision ne veulent rien dire : pas de compteur
  const needsPoll = (id: GapTab) => id === 'notMonitored' || id === 'unknownMonitored';
  const reliable = (id: GapTab) => Boolean(g) && (!needsPoll(id) || Boolean(g?.available));
  const tabs = (['notMonitored', 'unknownMonitored', 'citedNotInInventory', 'toValidate'] as GapTab[]).map((id) => ({
    id,
    label: t(`monitoring.gaps.${id}` as 'monitoring.gaps.notMonitored'),
    count: reliable(id) ? (id === 'toValidate' ? (g?.counts.toValidate ?? g?.toValidate?.length ?? null) : (g?.counts[id] ?? null)) : null,
  }));

  return (
    <Card
      title={t('monitoring.gaps.title')}
      description={t('monitoring.gaps.desc')}
      padded={false}
      actions={
        <a
          href={api.gapsCsvUrl()}
          download="ecarts-naemon.csv"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium whitespace-nowrap text-ink transition-colors hover:bg-surface-2"
        >
          <Download aria-hidden size={14} strokeWidth={1.75} />
          {t('monitoring.gaps.csv')}
        </a>
      }
    >
      {gaps.loading ? (
        <SkeletonRows rows={4} />
      ) : !g ? (
        <div className="p-4">
          <ErrorState error={gaps.error} onRetry={gaps.reload} retrying={gaps.refreshing} />
        </div>
      ) : (
        <>
          <Tabs tabs={tabs} value={tab} onChange={(id) => setTab(id as GapTab)} idPrefix="gaps" label={t('monitoring.gaps.title')} className="px-3" />
          <div role="tabpanel" id={`gaps-panel-${tab}`} aria-labelledby={`gaps-tab-${tab}`}>
            {!reliable(tab) ? (
              <EmptyState
                compact
                icon={Activity}
                title={off ? t('common.monitoringOff') : t('monitoring.gaps.noPoll')}
                text={off ? t('common.monitoringOffText') : t('monitoring.gaps.noPollText')}
              />
            ) : tab === 'notMonitored' ? (
              <NotMonitoredList rows={g.notMonitored} />
            ) : tab === 'toValidate' ? (
              <ToValidateList rows={g.toValidate ?? []} />
            ) : (
              <NameList names={tab === 'unknownMonitored' ? g.unknownMonitored : g.citedNotInInventory} tab={tab} />
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function NotMonitoredList({ rows }: { rows: Gaps['notMonitored'] }) {
  const { t } = useI18n();
  const [filter] = useEnvFilter();
  const visible = rows.filter((r) => envVisible(filter, r.env));
  const hidden = rows.length - visible.length;
  const columns: Column<Gaps['notMonitored'][number]>[] = [
    {
      key: 'name',
      header: t('servers.col.name'),
      sortValue: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <Link to={serverHref(r.id)} className="link font-mono text-xs font-medium whitespace-nowrap">
          {r.name}
        </Link>
      ),
    },
    {
      key: 'env',
      header: t('servers.col.env'),
      sortValue: (r) => {
        const i = ENVS.indexOf(r.env as Env);
        return i < 0 ? ENVS.length : i;
      },
      cell: (r) => <EnvBadge env={r.env} />,
    },
    {
      key: 'ip',
      header: t('servers.col.ip'),
      sortValue: (r) => r.ip,
      cell: (r) => (r.ip ? <span className="font-mono text-xs">{r.ip}</span> : <span className="text-xs text-ink-3">{t('common.none')}</span>),
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 border-b border-line px-3 py-1">
        <EnvFilter counts={countByEnv(rows)} />
        {hidden > 0 && <span className="text-xs text-ink-3">{t('monitoring.alerts.hidden', { n: hidden })}</span>}
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon={ServerOff} title={t('monitoring.gaps.notMonitored.empty')} />
      ) : (
        <Table
          columns={columns}
          rows={visible}
          rowKey={(r) => r.id}
          rowHref={(r) => serverHref(r.id)}
          defaultSort={{ key: 'env', dir: 'asc' }}
          caption={t('monitoring.gaps.notMonitored')}
          empty={<EmptyState compact icon={ServerOff} title={t('monitoring.alerts.allHidden')} text={t('monitoring.alerts.allHiddenText')} />}
        />
      )}
    </>
  );
}

/** Liens lus dans la documentation que rien ne corrobore : élément cité, application, page, type de lien. */
function ToValidateList({ rows }: { rows: GapToValidate[] }) {
  const { t } = useI18n();
  if (rows.length === 0) return <EmptyState compact icon={ShieldQuestion} title={t('monitoring.gaps.toValidate.empty')} />;
  const linkLabel = (type: string) => {
    const key = `linkType.${type}` as Key;
    const label = t(key);
    return label === key ? type : label;
  };
  const columns: Column<GapToValidate>[] = [
    {
      key: 'item',
      header: t('monitoring.gaps.col.item'),
      sortValue: (r) => r.target.name.toLowerCase(),
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {r.target.type === 'server' ? (
            <Link to={serverHref(r.target.id)} className="link font-mono text-xs font-medium whitespace-nowrap">
              {r.target.name}
            </Link>
          ) : r.target.type === 'application' ? (
            <Link to={appHref(r.target.id)} className="link text-[13px] font-medium">
              {r.target.name}
            </Link>
          ) : (
            <span className="text-[13px] font-medium text-ink">{r.target.name}</span>
          )}
          {r.target.type === 'server' && r.target.env !== undefined && <EnvBadge env={r.target.env} />}
        </span>
      ),
    },
    {
      key: 'app',
      header: t('monitoring.gaps.col.app'),
      sortValue: (r) => r.application.name.toLowerCase(),
      cell: (r) => (
        <Link to={appHref(r.application.id)} className="link text-[13px]">
          {r.application.name}
        </Link>
      ),
    },
    {
      key: 'link',
      header: t('monitoring.gaps.col.link'),
      hideOnMobile: true,
      sortValue: (r) => linkLabel(r.type),
      cell: (r) => <span className="text-xs text-ink-2">{linkLabel(r.type)}</span>,
    },
    {
      key: 'page',
      header: t('monitoring.gaps.col.page'),
      sortValue: (r) => r.page?.title.toLowerCase() ?? null,
      cell: (r) =>
        r.page?.url ? (
          <a href={r.page.url} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1 text-xs">
            <ExternalLink aria-hidden size={11} className="shrink-0" />
            {r.page.title}
          </a>
        ) : r.page ? (
          <span className="text-xs text-ink-2">{r.page.title}</span>
        ) : (
          <span className="text-xs text-ink-3">{t('common.none')}</span>
        ),
    },
  ];
  return (
    <>
      <p className="border-b border-line px-4 py-2 text-xs text-ink-2">{t('monitoring.gaps.toValidate.help')}</p>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.application.id}|${r.target.id}|${r.type}`}
        defaultSort={{ key: 'app', dir: 'asc' }}
        caption={t('monitoring.gaps.toValidate')}
      />
    </>
  );
}

function NameList({ names, tab }: { names: string[]; tab: 'unknownMonitored' | 'citedNotInInventory' }) {
  const { t } = useI18n();
  const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (sorted.length === 0) {
    return <EmptyState compact icon={tab === 'unknownMonitored' ? EyeOff : FileSearch} title={t(`monitoring.gaps.${tab}.empty` as 'monitoring.gaps.unknownMonitored.empty')} />;
  }
  return (
    <>
      <p className="border-b border-line px-4 py-2 text-xs text-ink-2">{t(`monitoring.gaps.${tab}.help` as 'monitoring.gaps.unknownMonitored.help')}</p>
      <ul className={cn('grid grid-cols-1 gap-x-6 px-4 py-2 sm:grid-cols-2 lg:grid-cols-3')}>
        {sorted.map((n) => (
          <li key={n} className="truncate py-1 font-mono text-xs text-ink" title={n}>
            {n}
          </li>
        ))}
      </ul>
    </>
  );
}
