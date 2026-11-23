/**
 * Fiche application : onglets Vue d'ensemble, Cartographie, Serveurs, Bases, Flux, Documentation,
 * Supervision, Historique. L'onglet actif est gardé dans l'adresse (?tab=servers).
 * Données : /api/applications/:id (relu toutes les minutes), états en direct (/api/status partagé),
 * /api/changes pour l'historique (chargé à l'ouverture de l'onglet).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  Activity,
  AppWindow,
  Database,
  ExternalLink,
  FileText,
  History as HistoryIcon,
  LayoutDashboard,
  Network,
  Server as ServerIcon,
  ShieldAlert,
  Waypoints,
} from 'lucide-react';
import { ApiError, api, REFRESH_MS, useApi, type ApplicationDetail, type Env, type LinkedNode, type LinkedServer, type Ref } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { useConfig, naemonLink } from '../lib/config';
import { useLiveStatus } from '../lib/live';
import { ENVS, envKey, isAlerting, serviceState, severity, worstState } from '../lib/status';
import { epochSeconds, formatDateTime, relativeTime } from '../lib/format';
import { auditInfo, changesTouching, nodeLabel, sqlDate } from '../lib/applications';
import { appHref, appMapHref, serverHref } from '../lib/links';
import { sourceLabel } from '../lib/sources';
import { cn } from '../lib/cn';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorState,
  PageHeader,
  ScoreMeter,
  Skeleton,
  SkeletonRows,
  StatusPill,
  Table,
  Tabs,
  scoreTone,
  type Column,
  type TabItem,
} from '../components/ui';
import { CheckToggle } from '../components/filters';
import { EnvFilter } from '../components/EnvFilter';
import { envVisible, useEnvFilter } from '../lib/envFilter';
import { AppPath } from '../components/AppPath';
import { ChangeDetail, ChangeHeader } from '../components/ChangeEntry';

const TAB_IDS = ['overview', 'map', 'servers', 'databases', 'flows', 'docs', 'monitoring', 'history'] as const;
type TabId = (typeof TAB_IDS)[number];
const isTab = (v: string | null): v is TabId => v !== null && (TAB_IDS as readonly string[]).includes(v);

export default function ApplicationPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: TabId = isTab(tabParam) ? tabParam : 'overview';
  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };
  const { data: app, error, loading, refreshing, reload } = useApi((signal) => api.application(id, { signal }), [id], { refreshMs: REFRESH_MS });
  useTitle(app?.name ?? t('page.application.title'));

  const back = { to: '/applications', label: t('nav.applications') };

  if (loading) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-56" />} back={back} />
        <Skeleton className="mb-4 h-9 w-full" />
        <div className="rounded-lg border border-line bg-surface">
          <SkeletonRows rows={6} />
        </div>
      </>
    );
  }
  if (!app) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <>
          <PageHeader title={t('appDetail.notFound')} back={back} />
          <Card>
            <EmptyState
              icon={AppWindow}
              title={t('appDetail.notFound')}
              text={t('appDetail.notFoundText')}
              action={
                <Button to="/applications" size="sm">
                  {t('nav.applications')}
                </Button>
              }
            />
          </Card>
        </>
      );
    }
    return (
      <>
        <PageHeader title={t('page.application.title')} back={back} />
        <ErrorState error={error} onRetry={reload} retrying={refreshing} />
      </>
    );
  }

  return (
    <>
      <AppHeader app={app} back={back} />
      {error && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      <AppTabs app={app} tab={tab} setTab={setTab} />
      <div role="tabpanel" id={`app-panel-${tab}`} aria-labelledby={`app-tab-${tab}`} className="mt-4">
        {tab === 'overview' && <OverviewTab app={app} />}
        {tab === 'map' && <MapTab app={app} />}
        {tab === 'servers' && <ServersTab app={app} />}
        {tab === 'databases' && <DatabasesTab app={app} />}
        {tab === 'flows' && <FlowsTab app={app} />}
        {tab === 'docs' && <DocsTab app={app} />}
        {tab === 'monitoring' && <MonitoringTab app={app} />}
        {tab === 'history' && <HistoryTab app={app} />}
      </div>
    </>
  );
}

// ---------- en-tête et onglets ----------

function AppHeader({ app, back }: { app: ApplicationDetail; back: { to: string; label: string } }) {
  const { t } = useI18n();
  const { config } = useConfig();
  const naemon = naemonLink(config?.naemonUrlTemplate, app.name);
  return (
    <PageHeader
      title={app.name}
      back={back}
      meta={
        <>
          <StatusPill state={app.status?.state} />
          {app.status?.atRisk && (
            <Badge tone="warn" icon={ShieldAlert}>
              {t('state.atRisk')}
            </Badge>
          )}
          {app.criticality && <Badge title={t('appDetail.fact.criticality')}>{app.criticality}</Badge>}
          {!app.inPerimeter && <Badge>{t('common.outOfPerimeter')}</Badge>}
          {app.retired && <Badge>{t('common.retired')}</Badge>}
        </>
      }
      actions={
        <>
          {naemon && (
            <Button href={naemon} icon={ExternalLink}>
              {t('common.openInNaemon')}
            </Button>
          )}
          <Button to={appMapHref(app.id)} icon={Network}>
            {t('appDetail.openMap')}
          </Button>
        </>
      }
    />
  );
}

function AppTabs({ app, tab, setTab }: { app: ApplicationDetail; tab: TabId; setTab: (id: string) => void }) {
  const { t } = useI18n();
  const { status: live } = useLiveStatus();
  // petit écran : l'onglet ouvert depuis l'adresse (?tab=docs) reste visible dans la barre qui défile
  useEffect(() => {
    document.getElementById(`app-tab-${tab}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  const active = <T extends { retired: boolean }>(list: T[]) => list.filter((x) => !x.retired);
  const servers = active(app.serverList);
  const alerting = servers.filter((s) => isAlerting(live?.servers[s.id]?.state ?? s.state)).length;
  const tabs: TabItem[] = [
    { id: 'overview', label: t('appDetail.tab.overview'), icon: LayoutDashboard },
    { id: 'map', label: t('appDetail.tab.map'), icon: Network },
    { id: 'servers', label: t('appDetail.tab.servers'), icon: ServerIcon, count: servers.length },
    { id: 'databases', label: t('appDetail.tab.databases'), icon: Database, count: active(app.databaseList).length },
    { id: 'flows', label: t('appDetail.tab.flows'), icon: Waypoints, count: active(app.callsList).length + app.usedBy.length },
    { id: 'docs', label: t('appDetail.tab.docs'), icon: FileText, count: app.documents.length },
    { id: 'monitoring', label: t('appDetail.tab.monitoring'), icon: Activity, count: alerting || null },
    { id: 'history', label: t('appDetail.tab.history'), icon: HistoryIcon },
  ];
  return <Tabs tabs={tabs} value={tab} onChange={setTab} idPrefix="app" label={t('appDetail.tabsLabel')} />;
}

// ---------- outils communs ----------

/** État en direct d'un serveur (relève partagée), sinon celui de la fiche. */
function useServerState() {
  const { status } = useLiveStatus();
  return (s: LinkedServer) => status?.servers[s.id]?.state ?? s.state;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-ink-3">{children}</span>;
}

function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((it) => (
        <div key={it.label} className="flex items-center justify-between gap-3 px-4 py-2">
          <dt className="text-xs text-ink-2">{it.label}</dt>
          <dd className="min-w-0 text-right text-[13px] text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- Vue d'ensemble ----------

function OverviewTab({ app }: { app: ApplicationDetail }) {
  const { t, lang } = useI18n();
  const summaryEn = typeof app.attrs?.summaryEn === 'string' ? app.attrs.summaryEn : null;
  const summary = (lang === 'en' && summaryEn) || app.summary || app.description;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        {app.status?.atRisk && <AtRiskCard app={app} />}
        <Card title={t('appDetail.summary')}>
          {summary ? (
            <p className="max-w-prose text-sm leading-6 text-ink">{summary}</p>
          ) : (
            <EmptyState compact icon={FileText} title={t('appDetail.noSummary')} text={t('appDetail.noSummaryText')} />
          )}
        </Card>
        <EnvStatesCard app={app} />
      </div>
      <Card title={t('appDetail.facts')} padded={false} className="self-start">
        <Facts
          items={[
            { label: t('appDetail.fact.criticality'), value: app.criticality ?? <Muted>{t('common.notSpecified')}</Muted> },
            { label: t('appDetail.fact.perimeter'), value: app.inPerimeter ? t('apps.filter.in') : t('apps.filter.out') },
            { label: t('appDetail.fact.servers'), value: <span className="tabular">{app.servers}</span> },
            { label: t('appDetail.fact.databases'), value: <span className="tabular">{app.databases}</span> },
            { label: t('common.docScore'), value: <ScoreMeter score={app.docScore?.score ?? 0} label={t('common.docScore')} /> },
            {
              label: t('appDetail.fact.lastSync'),
              value: app.lastSync ? <span title={formatDateTime(sqlDate(app.lastSync), lang)}>{relativeTime(sqlDate(app.lastSync), lang)}</span> : <Muted>{t('time.never')}</Muted>,
            },
          ]}
        />
      </Card>
    </div>
  );
}

function AtRiskCard({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  const risk = app.status.atRisk;
  // noms et états des applications de la chaîne (la fiche ne connaît que ses voisines directes)
  const { data: all } = useApi((signal) => api.applications({ signal }), [app.id], { enabled: Boolean(risk) });
  const { status: live } = useLiveStatus();
  if (!risk) return null;
  const known = new Map<string, string>();
  for (const r of [...app.callsList, ...app.usedBy]) known.set(r.id, r.name);
  for (const a of all ?? []) known.set(a.id, a.name);
  known.set(app.id, app.name);
  const ref = (id: string): Ref => ({ id, name: known.get(id) ?? nodeLabel(id, undefined) });
  const path = risk.path.length ? risk.path.map(ref) : [ref(app.id), ref(risk.because)];
  const becauseState = live?.apps[risk.because]?.state ?? all?.find((a) => a.id === risk.because)?.status.state ?? null;
  return (
    <section className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
      <div className="flex items-start gap-2.5">
        <ShieldAlert aria-hidden size={18} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink">{t('appDetail.atRisk.title')}</h2>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {t('appDetail.atRisk.text', { app: ref(risk.because).name, state: t(becauseState ? (`state.${becauseState}` as Key) : 'state.unknown') })}
          </p>
          <div className="mt-2">
            <AppPath path={path} label={t('appDetail.atRisk.path')} failingState={becauseState ?? 'down'} />
          </div>
        </div>
      </div>
    </section>
  );
}

function EnvStatesCard({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  const stateOf = useServerState();
  const servers = app.serverList.filter((s) => !s.retired);
  const rows: { env: Env | null; state: string; count: number }[] = [];
  for (const env of ENVS) {
    const list = servers.filter((s) => s.env === env);
    if (!list.length && !app.environments.includes(env)) continue;
    rows.push({ env, state: app.status?.byEnv?.[env] ?? worstState(list.map(stateOf)), count: list.length });
  }
  const none = servers.filter((s) => envKey(s.env) === 'none');
  if (none.length) rows.push({ env: null, state: worstState(none.map(stateOf)), count: none.length });
  return (
    <Card title={t('appDetail.envStates')} padded={false}>
      {rows.length === 0 ? (
        <EmptyState compact icon={ServerIcon} title={t('appDetail.envStatesEmpty')} />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={envKey(r.env)} className="flex items-center gap-3 px-4 py-2.5">
              <EnvBadge env={r.env} long />
              <span className="flex-1 text-xs text-ink-3">{t('count.servers', { n: r.count })}</span>
              <StatusPill state={r.state} size="sm" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------- Cartographie ----------

function MapTab({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  return (
    <Card>
      <EmptyState
        icon={Network}
        title={t('appDetail.map.title')}
        text={t('appDetail.map.text')}
        action={
          <Button variant="primary" to={appMapHref(app.id)} icon={Network}>
            {t('appDetail.map.open')}
          </Button>
        }
      />
    </Card>
  );
}

// ---------- Serveurs ----------

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-1.5">{children}</div>;
}

function ServersTab({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  const stateOf = useServerState();
  const [envFilter] = useEnvFilter();
  const [showRetired, setShowRetired] = useState(false);
  const all = app.serverList;
  const retiredCount = all.filter((s) => s.retired && envVisible(envFilter, s.env)).length;
  const rows = useMemo(
    () => all.filter((s) => envVisible(envFilter, s.env) && (showRetired || !s.retired)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [all, envFilter, showRetired],
  );
  const envCounts = { PRD: 0, STG: 0, DEV: 0, none: 0 };
  for (const s of all) if (showRetired || !s.retired) envCounts[s.env ?? 'none'] += 1;
  const columns: Column<LinkedServer>[] = [
    {
      key: 'name',
      header: t('appDetail.col.server'),
      sortValue: (s) => s.name,
      cell: (s) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Link to={serverHref(s.id)} className={cn('font-mono text-xs font-medium', s.retired ? 'text-ink-3 hover:underline' : 'link')}>
            {s.name}
          </Link>
          {s.retired && <Badge>{t('common.retired')}</Badge>}
        </span>
      ),
    },
    {
      key: 'env',
      header: t('appDetail.col.env'),
      sortValue: (s) => {
        const i = ENVS.indexOf(s.env as Env);
        return i < 0 ? ENVS.length : i;
      },
      cell: (s) => <EnvBadge env={s.env} />,
    },
    { key: 'state', header: t('appDetail.col.state'), sortValue: (s) => -severity(stateOf(s)), cell: (s) => <StatusPill state={stateOf(s)} size="sm" /> },
    {
      key: 'ip',
      header: t('appDetail.col.ip'),
      sortValue: (s) => attr(s, 'ip'),
      cell: (s) => (attr(s, 'ip') ? <span className="font-mono text-xs">{attr(s, 'ip')}</span> : <Muted>{t('common.none')}</Muted>),
    },
    {
      key: 'os',
      header: t('appDetail.col.os'),
      hideOnMobile: true,
      sortValue: (s) => osLabel(s),
      cell: (s) => (osLabel(s) ? <span className="text-xs text-ink-2">{osLabel(s)}</span> : <Muted>{t('common.none')}</Muted>),
    },
  ];
  return (
    <Card padded={false}>
      <Toolbar>
        <EnvFilter counts={envCounts} />
        {retiredCount > 0 && (
          <CheckToggle checked={showRetired} onChange={setShowRetired}>
            {t('common.showRetired', { n: retiredCount })}
          </CheckToggle>
        )}
      </Toolbar>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        rowHref={(s) => serverHref(s.id)}
        rowMuted={(s) => s.retired}
        defaultSort={{ key: 'env', dir: 'asc' }}
        caption={t('appDetail.tab.servers')}
        empty={<EmptyState compact icon={ServerIcon} title={t('appDetail.servers.empty')} text={t('appDetail.servers.emptyText')} />}
      />
    </Card>
  );
}

const attr = (n: LinkedNode, key: string): string | null => {
  const v = n.attrs?.[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
};
const osLabel = (s: LinkedNode): string | null => [attr(s, 'os'), attr(s, 'osVersion')].filter(Boolean).join(' ') || null;

// ---------- Bases ----------

function SourceBadges({ sources }: { sources: string[] }) {
  const { t } = useI18n();
  if (!sources?.length) return <Muted>{t('common.none')}</Muted>;
  return (
    <span className="flex flex-wrap gap-1">
      {sources.map((s) => (
        <Badge key={s}>{sourceLabel(t, s)}</Badge>
      ))}
    </span>
  );
}

function DatabasesTab({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  const [showRetired, setShowRetired] = useState(false);
  const retiredCount = app.databaseList.filter((d) => d.retired).length;
  const rows = app.databaseList.filter((d) => showRetired || !d.retired);
  const columns: Column<LinkedNode>[] = [
    {
      key: 'name',
      header: t('appDetail.col.database'),
      sortValue: (d) => d.name,
      cell: (d) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className={cn('font-medium', d.retired ? 'text-ink-3' : 'text-ink')}>{d.name}</span>
          {d.retired && <Badge>{t('common.retired')}</Badge>}
        </span>
      ),
    },
    { key: 'engine', header: t('appDetail.col.engine'), sortValue: (d) => attr(d, 'engine'), cell: (d) => attr(d, 'engine') ?? <Muted>{t('common.notSpecified')}</Muted> },
    { key: 'sources', header: t('appDetail.col.sources'), hideOnMobile: true, cell: (d) => <SourceBadges sources={d.sources} /> },
  ];
  return (
    <Card padded={false}>
      {retiredCount > 0 && (
        <Toolbar>
          <CheckToggle checked={showRetired} onChange={setShowRetired}>
            {t('common.showRetired', { n: retiredCount })}
          </CheckToggle>
        </Toolbar>
      )}
      <Table
        columns={columns}
        rows={rows}
        rowKey={(d) => d.id}
        rowMuted={(d) => d.retired}
        defaultSort={{ key: 'name', dir: 'asc' }}
        caption={t('appDetail.tab.databases')}
        empty={<EmptyState compact icon={Database} title={t('appDetail.databases.empty')} text={t('appDetail.databases.emptyText')} />}
      />
    </Card>
  );
}

// ---------- Flux ----------

function FlowsTab({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  const { status: live } = useLiveStatus();
  const [showRetired, setShowRetired] = useState(false);
  const retiredCount = app.callsList.filter((c) => c.retired).length;
  const calls = app.callsList.filter((c) => showRetired || !c.retired).sort((a, b) => a.name.localeCompare(b.name));
  const usedBy = [...app.usedBy].sort((a, b) => a.name.localeCompare(b.name));
  const appState = (id: string) => live?.apps[id]?.state ?? 'unknown';
  const row = (r: Ref, extra?: { retired?: boolean; criticality?: string | null }) => (
    <li key={r.id} className={cn('flex items-center gap-3 px-4 py-2', extra?.retired && 'text-ink-3')}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <Link to={appHref(r.id)} className={cn('truncate text-[13px] font-medium', extra?.retired ? 'text-ink-3 hover:underline' : 'link')}>
          {r.name}
        </Link>
        {extra?.criticality && <Badge>{extra.criticality}</Badge>}
        {extra?.retired && <Badge>{t('common.retired')}</Badge>}
      </span>
      <StatusPill state={appState(r.id)} size="sm" />
    </li>
  );
  return (
    <div className="flex flex-col gap-4">
      {retiredCount > 0 && (
        <CheckToggle checked={showRetired} onChange={setShowRetired} className="self-start">
          {t('common.showRetired', { n: retiredCount })}
        </CheckToggle>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={t('appDetail.flows.out')} padded={false}>
          {calls.length === 0 ? (
            <EmptyState compact icon={Waypoints} title={t('appDetail.flows.emptyOut')} />
          ) : (
            <ul className="divide-y divide-line">{calls.map((c) => row(c, { retired: c.retired, criticality: attr(c, 'criticality') }))}</ul>
          )}
        </Card>
        <Card title={t('appDetail.flows.in')} padded={false}>
          {usedBy.length === 0 ? <EmptyState compact icon={Waypoints} title={t('appDetail.flows.emptyIn')} /> : <ul className="divide-y divide-line">{usedBy.map((u) => row(u))}</ul>}
        </Card>
      </div>
    </div>
  );
}

// ---------- Documentation ----------

function DocsTab({ app }: { app: ApplicationDetail }) {
  const { t, lang } = useI18n();
  const score = app.docScore?.score ?? 0;
  const tone = scoreTone(score);
  const docs = [...app.documents].sort((a, b) => Number(b.architecture) - Number(a.architecture) || a.name.localeCompare(b.name));
  const columns: Column<(typeof docs)[number]>[] = [
    {
      key: 'name',
      header: t('appDetail.col.page'),
      sortValue: (d) => d.name,
      cell: (d) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {d.url ? (
            <a href={d.url} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1 font-medium">
              {d.name}
              <ExternalLink aria-hidden size={12} />
            </a>
          ) : (
            <span className="font-medium text-ink">{d.name}</span>
          )}
          {d.architecture && <Badge tone="accent">{t('appDetail.docs.architecture')}</Badge>}
        </span>
      ),
    },
    {
      key: 'env',
      header: t('appDetail.col.env'),
      hideOnMobile: true,
      cell: (d) => {
        const env = auditInfo(d.audit).env;
        return env ? <EnvBadge env={env as Env} /> : null;
      },
    },
    {
      key: 'check',
      header: t('appDetail.col.check'),
      sortValue: (d) => {
        const a = auditInfo(d.audit);
        return a.ok === null ? null : a.ok ? 1 : 0;
      },
      cell: (d) => {
        const a = auditInfo(d.audit);
        if (a.ok === null) return d.architecture ? <Muted>{t('appDetail.docs.notChecked')}</Muted> : null;
        if (a.ok) return <Badge tone="ok">{t('appDetail.docs.consistent')}</Badge>;
        return (
          <div className="flex flex-col items-start gap-0.5">
            <Badge tone="warn">{t('appDetail.docs.gap')}</Badge>
            <span className="text-xs text-ink-2">{a.problems.map((p) => t(`docProblem.${p.code}` as Key, { n: p.n })).join(t('common.listSep'))}</span>
          </div>
        );
      },
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card title={t('common.docScore')} description={t('appDetail.docs.scoreDesc')} className="self-start">
        <div className="flex items-baseline gap-1">
          <span className={cn('tabular text-3xl font-semibold tracking-tight', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-down')}>{score}</span>
          <span className="text-sm text-ink-3">/ 100</span>
        </div>
        <ul className="mt-4 flex flex-col gap-3">
          {(app.docScore?.parts ?? []).map((p) => {
            const label = t(`docPart.${p.key}` as Key);
            const pct = p.max ? Math.round((100 * p.points) / p.max) : 0;
            return (
              <li key={p.key}>
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="text-ink">{label.startsWith('docPart.') ? p.key : label}</span>
                  <span className="tabular shrink-0 text-xs text-ink-2">
                    {p.points} / {p.max}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <div className={cn('h-full rounded-full', p.points >= p.max ? 'bg-ok' : p.points > 0 ? 'bg-warn' : 'bg-down')} style={{ width: `${Math.max(pct, p.points ? 0 : 3)}%` }} />
                </div>
                {/* le détail est rédigé par le serveur en français */}
                {lang === 'fr' && p.detail && <p className="mt-0.5 text-xs text-ink-3">{p.detail}</p>}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title={t('appDetail.docs.pages')} padded={false} className="min-w-0 lg:col-span-2">
        <Table
          columns={columns}
          rows={docs}
          rowKey={(d) => d.id}
          caption={t('appDetail.docs.pages')}
          empty={<EmptyState compact icon={FileText} title={t('appDetail.docs.empty')} text={t('appDetail.docs.emptyText')} />}
        />
      </Card>
    </div>
  );
}

// ---------- Supervision ----------

function MonitoringTab({ app }: { app: ApplicationDetail }) {
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const { status: live } = useLiveStatus();
  const [envFilter] = useEnvFilter();
  if (config?.naemonSource === 'off' || live?.source === 'off') {
    return (
      <Card>
        <EmptyState icon={Activity} title={t('common.monitoringOff')} text={t('common.monitoringOffText')} />
      </Card>
    );
  }
  const active = app.serverList.filter((s) => !s.retired);
  const envCounts = { PRD: 0, STG: 0, DEV: 0, none: 0 };
  for (const s of active) envCounts[s.env ?? 'none'] += 1;
  const servers = active
    .filter((s) => envVisible(envFilter, s.env))
    .map((s) => ({ server: s, live: live?.servers[s.id] ?? null }))
    .map((x) => ({ ...x, state: x.live?.state ?? x.server.state }))
    .sort((a, b) => severity(b.state) - severity(a.state) || a.server.name.localeCompare(b.server.name, undefined, { numeric: true }));

  return (
    <Card padded={false}>
      <Toolbar>
        <EnvFilter counts={envCounts} />
      </Toolbar>
      {servers.length === 0 ? (
        <EmptyState compact icon={ServerIcon} title={t('appDetail.mon.empty')} text={t('appDetail.servers.emptyText')} />
      ) : (
        <ul className="divide-y divide-line">
          {servers.map(({ server, live: l, state }) => {
            const services = (l?.services ?? []).map((sv) => ({ ...sv, st: serviceState(sv.state, sv.downtime) }));
            const problems = services.filter((sv) => sv.st !== 'ok').sort((a, b) => severity(b.st) - severity(a.st));
            const okCount = services.length - problems.length;
            const checked = epochSeconds(l?.lastCheck);
            return (
              <li key={server.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:gap-4">
                <div className="flex shrink-0 flex-wrap items-center gap-2 self-start md:w-64">
                  <StatusPill state={state} size="sm" ack={l?.ack} />
                  <Link to={serverHref(server.id)} className="link font-mono text-xs font-medium">
                    {server.name}
                  </Link>
                  <EnvBadge env={server.env} />
                </div>
                <div className="min-w-0 flex-1">
                  {l?.output && <p className="text-xs break-words text-ink-2">{l.output}</p>}
                  {checked && (
                    <p className="text-2xs text-ink-3" title={formatDateTime(checked, lang)}>
                      {t('appDetail.mon.checked', { ago: relativeTime(checked, lang) })}
                    </p>
                  )}
                  {problems.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {problems.map((sv) => (
                        <li key={sv.description} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <StatusPill state={sv.st} size="sm" ack={sv.ack} />
                          <span className="font-medium text-ink">{sv.description}</span>
                          <span className="min-w-0 break-words text-ink-2">{sv.output}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {services.length === 0 ? (
                    <p className="text-2xs text-ink-3">{t('appDetail.mon.noServices')}</p>
                  ) : (
                    okCount > 0 && (
                      <details className="group mt-1 text-xs">
                        <summary className="cursor-pointer text-ink-3 select-none hover:text-ink">{t('appDetail.mon.servicesOk', { n: okCount })}</summary>
                        <ul className="mt-1 flex flex-col gap-1 pl-3">
                          {services
                            .filter((sv) => sv.st === 'ok')
                            .map((sv) => (
                              <li key={sv.description} className="flex flex-wrap items-center gap-x-2">
                                <StatusPill state="ok" size="sm" />
                                <span className="text-ink">{sv.description}</span>
                                <span className="text-ink-3">{sv.output}</span>
                              </li>
                            ))}
                        </ul>
                      </details>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------- Historique ----------

/** Les 200 derniers changements (maximum de l'API), filtrés sur l'application, ses serveurs et ses bases. */
const HISTORY_LIMIT = 200;

function HistoryTab({ app }: { app: ApplicationDetail }) {
  const { t } = useI18n();
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.changes(HISTORY_LIMIT, { signal }), []);
  const ids = useMemo(() => new Set([app.id, ...app.serverList.map((s) => s.id), ...app.databaseList.map((d) => d.id)]), [app]);
  const changes = useMemo(() => (data ? changesTouching(data, ids) : []), [data, ids]);
  return (
    <Card title={t('appDetail.tab.history')} description={t('appDetail.history.desc')} padded={false}>
      {loading ? (
        <SkeletonRows rows={4} />
      ) : !data ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={reload} retrying={refreshing} />
        </div>
      ) : changes.length === 0 ? (
        <EmptyState compact icon={HistoryIcon} title={t('appDetail.history.empty')} text={t('appDetail.history.emptyText')} />
      ) : (
        <ol className="divide-y divide-line">
          {changes.map((c, i) => (
            <li key={`${c.at}-${c.source}-${i}`} className="flex flex-col gap-2.5 px-4 py-3">
              <ChangeHeader change={c} />
              <ChangeDetail change={c} />
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
