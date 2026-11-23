/**
 * Liste des serveurs : nom, IP, environnement, état de supervision, applications, système.
 * Filtres : texte (nom, IP, application), état, environnements (PRD et STG par défaut, mémorisé), retirés.
 * Les états sont superposés en direct (relève partagée, une minute).
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Info, Server as ServerIcon, X } from 'lucide-react';
import { api, REFRESH_MS, useApi, type ServerState, type ServerSummary } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { useLiveStatus } from '../lib/live';
import { ENVS, SERVER_STATES, severity } from '../lib/status';
import { envVisible, useEnvFilter } from '../lib/envFilter';
import { appHref, serverHref } from '../lib/links';
import { cn } from '../lib/cn';
import { attrText, osLabel } from '../lib/servers';
import { Badge, Button, Card, EmptyState, EnvBadge, ErrorState, PageHeader, SkeletonRows, StatusPill, Table, type Column } from '../components/ui';
import { CheckToggle, SearchInput, SelectField } from '../components/filters';
import { EnvFilter } from '../components/EnvFilter';

/** Nombre maximal de serveurs demandés à l'API (au-delà, la liste est tronquée et on le dit). */
export const SERVERS_LIMIT = 5000;

type StateFilter = 'all' | ServerState;

export default function ServersPage() {
  const { t } = useI18n();
  useTitle(t('page.servers.title'));
  // l'API de recherche est limitée : on demande tout le parc d'un coup et on filtre ici
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.servers(undefined, SERVERS_LIMIT, { signal }), [], { refreshMs: REFRESH_MS });
  const { status: live } = useLiveStatus();
  const [envFilter] = useEnvFilter();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const stateParam = params.get('state');
  const state: StateFilter = SERVER_STATES.includes(stateParam as ServerState) ? (stateParam as ServerState) : 'all';
  const showRetired = params.get('retired') === '1';
  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    setParams(p, { replace: true });
  };

  const stateOf = (s: ServerSummary): ServerState => live?.servers[s.id]?.state ?? s.state;
  const servers = useMemo(() => data ?? [], [data]);

  const needle = q.trim().toLowerCase();
  const matchesText = (s: ServerSummary) =>
    !needle ||
    [s.name, attrText(s.attrs, 'ip'), attrText(s.attrs, 'fqdn'), ...s.applications.map((a) => a.name)].some((v) => v?.toLowerCase().includes(needle));

  // les retirés sont comptés parmi les serveurs que les autres filtres laissent passer
  const base = servers.filter((s) => envVisible(envFilter, s.env) && matchesText(s) && (state === 'all' || stateOf(s) === state));
  const retiredCount = base.filter((s) => s.retired).length;
  const rows = base.filter((s) => showRetired || !s.retired);
  const envCounts = useMemo(() => {
    const c = { PRD: 0, STG: 0, DEV: 0, none: 0 };
    for (const s of servers) if (!s.retired || showRetired) c[s.env ?? 'none'] += 1;
    return c;
  }, [servers, showRetired]);
  const filtered = q !== '' || state !== 'all' || showRetired;
  const reset = () => setParams(new URLSearchParams(), { replace: true });

  const columns: Column<ServerSummary>[] = [
    {
      key: 'name',
      header: t('servers.col.name'),
      sortValue: (s) => s.name.toLowerCase(),
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
      key: 'ip',
      header: t('servers.col.ip'),
      sortValue: (s) => attrText(s.attrs, 'ip'),
      cell: (s) => (attrText(s.attrs, 'ip') ? <span className="font-mono text-xs">{attrText(s.attrs, 'ip')}</span> : <span className="text-xs text-ink-3">{t('common.none')}</span>),
    },
    {
      key: 'env',
      header: t('servers.col.env'),
      sortValue: (s) => {
        const i = ENVS.indexOf(s.env as (typeof ENVS)[number]);
        return i < 0 ? ENVS.length : i;
      },
      cell: (s) => <EnvBadge env={s.env} />,
    },
    {
      key: 'state',
      header: t('servers.col.state'),
      sortValue: (s) => -severity(stateOf(s)),
      cell: (s) => <StatusPill state={stateOf(s)} size="sm" ack={Boolean(live?.servers[s.id]?.ack)} />,
    },
    {
      key: 'apps',
      header: t('servers.col.apps'),
      sortValue: (s) => s.applications[0]?.name.toLowerCase() ?? '',
      cell: (s) =>
        s.applications.length === 0 ? (
          <span className="text-xs text-ink-3">{t('common.none')}</span>
        ) : (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5">
            {s.applications.map((a) => (
              <Link key={a.id} to={appHref(a.id)} className="link text-xs">
                {a.name}
              </Link>
            ))}
          </span>
        ),
    },
    {
      key: 'os',
      header: t('servers.col.os'),
      hideOnMobile: true,
      sortValue: (s) => osLabel(s.attrs) ?? '',
      cell: (s) => (osLabel(s.attrs) ? <span className="text-xs text-ink-2">{osLabel(s.attrs)}</span> : <span className="text-xs text-ink-3">{t('common.none')}</span>),
    },
  ];

  const stateOptions: { value: StateFilter; label: string }[] = [
    { value: 'all', label: t('apps.filter.anyState') },
    ...SERVER_STATES.map((s) => ({ value: s as StateFilter, label: t(`state.${s}` as 'state.ok') })),
  ];

  return (
    <>
      <PageHeader
        title={t('page.servers.title')}
        subtitle={t('page.servers.subtitle')}
        meta={data && <Badge>{t('count.servers', { n: rows.length })}</Badge>}
      />
      {error && data && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      {data && data.length >= SERVERS_LIMIT && (
        <p role="status" className="mb-3 flex items-center gap-2 rounded-md border border-warn/35 bg-warn-soft px-3 py-2 text-xs text-ink">
          <Info aria-hidden size={14} className="shrink-0 text-warn" />
          {t('servers.capped', { n: SERVERS_LIMIT })}
        </p>
      )}
      <Card padded={false}>
        <div className="flex flex-col gap-x-4 gap-y-1 border-b border-line p-3 md:flex-row md:flex-wrap md:items-center">
          <SearchInput
            value={q}
            onChange={(v) => setParam('q', v)}
            placeholder={t('servers.search')}
            label={t('servers.search')}
            clearLabel={t('common.clearSearch')}
            className="md:w-72"
          />
          <SelectField
            label={t('apps.filter.state')}
            value={state}
            onChange={(v) => setParam('state', v === 'all' ? null : v)}
            options={stateOptions}
            className="md:w-44"
          />
          <EnvFilter counts={data ? envCounts : undefined} />
          <div className="flex flex-wrap items-center gap-x-3 md:ml-auto">
            <CheckToggle checked={showRetired} onChange={(v) => setParam('retired', v ? '1' : null)}>
              {t('common.showRetired', { n: retiredCount })}
            </CheckToggle>
            {filtered && (
              <Button size="sm" variant="ghost" icon={X} onClick={reset}>
                {t('apps.filter.reset')}
              </Button>
            )}
          </div>
        </div>
        {loading ? (
          <SkeletonRows rows={10} />
        ) : !data ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={reload} retrying={refreshing} />
          </div>
        ) : servers.length === 0 ? (
          <EmptyState icon={ServerIcon} title={t('servers.none')} text={t('servers.noneText')} />
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            rowHref={(s) => serverHref(s.id)}
            rowMuted={(s) => s.retired}
            defaultSort={{ key: 'state', dir: 'asc' }}
            caption={t('page.servers.title')}
            empty={<EmptyState compact icon={ServerIcon} title={t('servers.empty')} text={t('servers.emptyText')} />}
          />
        )}
      </Card>
    </>
  );
}
