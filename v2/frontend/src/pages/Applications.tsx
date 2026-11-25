/**
 * Liste des applications : état, criticité, environnements, serveurs, score de documentation.
 * Filtres (texte, état, criticité, périmètre, retirées) gardés dans l'adresse : un lien partagé garde la vue.
 */
import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AppWindow, ShieldAlert, X } from 'lucide-react';
import { api, REFRESH_MS, useApi, type ApplicationSummary } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { ENVS, severity } from '../lib/status';
import {
  DEFAULT_APP_FILTERS,
  criticalityOptions,
  criticalityRank,
  filterApplications,
  filtersFromParams,
  filtersToParams,
  hasActiveFilters,
  type AppFilters,
  type PerimeterFilter,
  type StateFilter,
} from '../lib/applications';
import { appHref } from '../lib/links';
import { Badge, Button, Card, EmptyState, EnvBadge, ErrorState, PageHeader, ScoreMeter, SkeletonRows, StatusPill, Table, type Column } from '../components/ui';
import { CheckToggle, SearchInput, SelectField } from '../components/filters';

export default function ApplicationsPage() {
  const { t } = useI18n();
  useTitle(t('page.applications.title'));
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.applications({ signal }), [], { refreshMs: REFRESH_MS });
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (patch: Partial<AppFilters>) => setParams(filtersToParams({ ...filters, ...patch }), { replace: true });

  const apps = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => filterApplications(apps, filters), [apps, filters]);
  const retiredCount = apps.filter((a) => a.retired).length;
  const totalVisible = filters.retired ? apps.length : apps.length - retiredCount;

  return (
    <>
      <PageHeader
        title={t('page.applications.title')}
        subtitle={t('page.applications.subtitle')}
        meta={data && <Badge>{t('count.applications', { n: totalVisible })}</Badge>}
      />
      {error && data && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      <Card padded={false}>
        <FilterBar apps={apps} filters={filters} setFilters={setFilters} retiredCount={retiredCount} shown={rows.length} total={totalVisible} ready={Boolean(data)} />
        {loading ? (
          <SkeletonRows rows={10} />
        ) : !data ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={reload} retrying={refreshing} />
          </div>
        ) : apps.length === 0 ? (
          <EmptyState icon={AppWindow} title={t('apps.none')} text={t('apps.noneText')} />
        ) : (
          <AppTable
            rows={rows}
            empty={
              <EmptyState
                compact
                title={t('apps.empty')}
                text={t('apps.emptyText')}
                action={
                  <Button size="sm" icon={X} onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                    {t('apps.filter.reset')}
                  </Button>
                }
              />
            }
          />
        )}
      </Card>
    </>
  );
}

function FilterBar({
  apps,
  filters,
  setFilters,
  retiredCount,
  shown,
  total,
  ready,
}: {
  apps: ApplicationSummary[];
  filters: AppFilters;
  setFilters: (patch: Partial<AppFilters>) => void;
  retiredCount: number;
  shown: number;
  total: number;
  ready: boolean;
}) {
  const { t } = useI18n();
  const crits = criticalityOptions(apps);
  const hasNone = apps.some((a) => !a.criticality);
  const stateOptions: { value: StateFilter; label: string }[] = [
    { value: 'all', label: t('apps.filter.anyState') },
    { value: 'down', label: t('state.down') },
    { value: 'degraded', label: t('state.degraded') },
    { value: 'atRisk', label: t('state.atRisk') },
    { value: 'unknown', label: t('state.unknown') },
    { value: 'ok', label: t('state.ok') },
  ];
  const critOptions = [
    { value: 'all', label: t('apps.filter.anyCriticality') },
    ...crits.map((c) => ({ value: c, label: c })),
    ...(hasNone || filters.criticality === 'none' ? [{ value: 'none', label: t('apps.filter.noCriticality') }] : []),
  ];
  // valeur venue d'un lien mais absente des données : gardée pour rester visible (et effaçable)
  if (!critOptions.some((o) => o.value === filters.criticality)) critOptions.push({ value: filters.criticality, label: filters.criticality });
  const perimeterOptions: { value: PerimeterFilter; label: string }[] = [
    { value: 'all', label: t('apps.filter.anyPerimeter') },
    { value: 'in', label: t('apps.filter.in') },
    { value: 'out', label: t('apps.filter.out') },
  ];
  const active = hasActiveFilters(filters);

  return (
    <div className="flex flex-col gap-2 border-b border-line p-3 md:flex-row md:flex-wrap md:items-center">
      <SearchInput
        value={filters.q}
        onChange={(q) => setFilters({ q })}
        placeholder={t('apps.search')}
        label={t('apps.search')}
        clearLabel={t('common.clearSearch')}
        className="md:w-64"
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:flex md:flex-wrap">
        <SelectField label={t('apps.filter.state')} value={filters.state} onChange={(state) => setFilters({ state })} options={stateOptions} className="md:w-40" />
        <SelectField label={t('apps.filter.criticality')} value={filters.criticality} onChange={(criticality) => setFilters({ criticality })} options={critOptions} className="md:w-44" />
        <SelectField
          label={t('apps.filter.perimeter')}
          value={filters.perimeter}
          onChange={(perimeter) => setFilters({ perimeter })}
          options={perimeterOptions}
          className="col-span-2 sm:col-span-1 md:w-48"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:ml-auto">
        {retiredCount > 0 && (
          <CheckToggle checked={filters.retired} onChange={(retired) => setFilters({ retired })}>
            {t('common.showRetired', { n: retiredCount })}
          </CheckToggle>
        )}
        {active && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => setFilters(DEFAULT_APP_FILTERS)}>
            {t('apps.filter.reset')}
          </Button>
        )}
        {ready && (
          <span className="tabular text-xs text-ink-3" aria-live="polite">
            {t('apps.count', { n: shown, total })}
          </span>
        )}
      </div>
    </div>
  );
}

function AppTable({ rows, empty }: { rows: ApplicationSummary[]; empty: ReactNode }) {
  const { t } = useI18n();
  const columns: Column<ApplicationSummary>[] = [
    {
      key: 'name',
      header: t('apps.col.name'),
      sortValue: (a) => a.name,
      cell: (a) => (
        <div className="min-w-0 max-w-[28rem]">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link to={appHref(a.id)} className={a.retired ? 'font-medium text-ink-3 hover:underline' : 'link font-medium'}>
              {a.name}
            </Link>
            {!a.inPerimeter && <Badge>{t('common.outOfPerimeter')}</Badge>}
            {a.retired && <Badge>{t('common.retired')}</Badge>}
          </div>
          {a.summary && (
            <p className="mt-0.5 hidden truncate text-xs text-ink-3 lg:block" title={a.summary}>
              {a.summary}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      header: t('apps.col.state'),
      // tri croissant = le plus grave d'abord ; à risque juste après le même état
      sortValue: (a) => -severity(a.status?.state) * 2 - (a.status?.atRisk ? 1 : 0),
      cell: (a) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusPill state={a.status?.state} size="sm" />
          {a.status?.atRisk && (
            <Badge tone="warn" icon={ShieldAlert}>
              {t('state.atRisk')}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'criticality',
      header: t('apps.col.criticality'),
      sortValue: (a) => (a.criticality ? -criticalityRank(a.criticality) : null),
      cell: (a) => (a.criticality ? <Badge>{a.criticality}</Badge> : <span className="text-xs text-ink-3">{t('common.notSpecified')}</span>),
    },
    {
      key: 'envs',
      header: t('apps.col.envs'),
      hideOnMobile: true,
      cell: (a) =>
        a.environments.length ? (
          <div className="flex flex-wrap gap-1">
            {ENVS.filter((e) => a.environments.includes(e)).map((e) => (
              <EnvBadge key={e} env={e} />
            ))}
          </div>
        ) : (
          <span className="text-xs text-ink-3">{t('common.notSpecified')}</span>
        ),
    },
    {
      key: 'servers',
      header: t('apps.col.servers'),
      align: 'right',
      hideOnMobile: true,
      sortValue: (a) => a.servers,
      cell: (a) => <span className="tabular">{a.servers}</span>,
    },
    {
      key: 'doc',
      header: t('apps.col.docScore'),
      hideOnMobile: true,
      sortValue: (a) => a.docScore?.score ?? null,
      cell: (a) => (a.docScore ? <ScoreMeter score={a.docScore.score} label={t('common.docScore')} /> : <span className="text-xs text-ink-3">{t('common.none')}</span>),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(a) => a.id}
      rowHref={(a) => appHref(a.id)}
      rowMuted={(a) => a.retired}
      defaultSort={{ key: 'name', dir: 'asc' }}
      caption={t('apps.caption')}
      empty={empty}
    />
  );
}
