/**
 * Fiche serveur : état, environnement, IP, attributs, applications hébergées, services Naemon,
 * pages de documentation qui le citent et historique des changements qui le touchent.
 * L'état en tête et les services sont superposés aux états en direct (relève partagée).
 */
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { Activity, AppWindow, ExternalLink, FileText, History as HistoryIcon, Server as ServerIcon, SlidersHorizontal } from 'lucide-react';
import { ApiError, api, REFRESH_MS, useApi, type Service, type ServerDetail } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { useConfig } from '../lib/config';
import { useLiveStatus } from '../lib/live';
import { epochSeconds, formatDateTime, relativeTime } from '../lib/format';
import { serviceState, severity } from '../lib/status';
import { appHref } from '../lib/links';
import { attrRows, attrText } from '../lib/servers';
import { Badge, Button, Card, EmptyState, EnvBadge, ErrorState, PageHeader, Skeleton, SkeletonRows, StatusPill, Table, type Column } from '../components/ui';
import { ChangeDetail, ChangeHeader } from '../components/ChangeEntry';

export default function ServerPage() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const { status: live } = useLiveStatus();
  const { data: server, error, loading, refreshing, reload } = useApi((signal) => api.server(id, { signal }), [id], { refreshMs: REFRESH_MS });
  useTitle(server?.name ?? t('page.server.title'));
  const back = { to: '/servers', label: t('nav.servers') };

  if (loading) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-56" />} back={back} />
        <div className="rounded-lg border border-line bg-surface">
          <SkeletonRows rows={6} />
        </div>
      </>
    );
  }
  if (!server) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <>
          <PageHeader title={t('server.notFound')} back={back} />
          <Card>
            <EmptyState
              icon={ServerIcon}
              title={t('server.notFound')}
              text={t('server.notFoundText')}
              action={
                <Button to="/servers" size="sm">
                  {t('nav.servers')}
                </Button>
              }
            />
          </Card>
        </>
      );
    }
    return (
      <>
        <PageHeader title={t('page.server.title')} back={back} />
        <ErrorState error={error} onRetry={reload} retrying={refreshing} />
      </>
    );
  }

  const l = live?.servers[server.id];
  const state = l?.state ?? server.state;
  const ack = l?.ack ?? server.ack;
  const output = l ? l.output : server.output;
  const checked = epochSeconds(l ? l.lastCheck : server.lastCheck);
  const services = l?.services ?? server.services;
  const monitoringOff = (config?.naemonSource === 'off' || live?.source === 'off') && services.length === 0;
  const ip = attrText(server.attrs, 'ip');

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{server.name}</span>}
        back={back}
        meta={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusPill state={state} ack={ack} />
            <EnvBadge env={server.env} long />
            {ip && <span className="font-mono text-xs text-ink-2">{ip}</span>}
            {server.retired && <Badge>{t('common.retired')}</Badge>}
          </span>
        }
      />
      {error && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      {output && !monitoringOff && (
        <p className="mb-4 text-[13px] break-words text-ink-2">
          {output}
          {checked && (
            <span className="ml-2 text-xs text-ink-3" title={formatDateTime(checked, lang)}>
              {t('appDetail.mon.checked', { ago: relativeTime(checked, lang) })}
            </span>
          )}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <AttributesCard attrs={server.attrs} />
        <ApplicationsCard server={server} />
        <ServicesCard services={services} off={monitoringOff} />
        <DocumentsCard server={server} />
        <HistoryCard server={server} />
      </div>
    </>
  );
}

function AttributesCard({ attrs }: { attrs: Record<string, unknown> }) {
  const { t } = useI18n();
  const rows = attrRows(attrs);
  return (
    <Card title={t('server.attributes')} padded={false} className="self-start lg:col-span-1">
      {rows.length === 0 ? (
        <EmptyState compact icon={SlidersHorizontal} title={t('server.attributes.empty')} />
      ) : (
        <dl className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.key} className="flex items-baseline justify-between gap-3 px-4 py-2">
              <dt className="shrink-0 text-xs text-ink-2">{r.label ? t(r.label) : <span className="font-mono">{r.key}</span>}</dt>
              <dd className="min-w-0 text-right text-[13px] break-words text-ink">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function ApplicationsCard({ server }: { server: ServerDetail }) {
  const { t } = useI18n();
  const apps = [...server.applications].sort((a, b) => severity(b.state) - severity(a.state) || a.name.localeCompare(b.name));
  return (
    <Card title={t('server.applications')} padded={false} className="self-start lg:col-span-2">
      {apps.length === 0 ? (
        <EmptyState compact icon={AppWindow} title={t('server.applications.empty')} />
      ) : (
        <ul className="divide-y divide-line">
          {apps.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <StatusPill state={a.state} size="sm" />
              <Link to={appHref(a.id)} className="link text-[13px] font-medium">
                {a.name}
              </Link>
              {a.criticality && <Badge>{a.criticality}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ServicesCard({ services, off }: { services: Service[]; off: boolean }) {
  const { t, lang } = useI18n();
  const rows = useMemo(() => [...services].sort((a, b) => severity(serviceState(b.state, b.downtime)) - severity(serviceState(a.state, a.downtime)) || a.description.localeCompare(b.description)), [services]);
  const columns: Column<Service>[] = [
    {
      key: 'state',
      header: t('server.col.state'),
      sortValue: (s) => -severity(serviceState(s.state, s.downtime)),
      cell: (s) => <StatusPill state={serviceState(s.state, s.downtime)} size="sm" ack={s.ack} />,
    },
    { key: 'service', header: t('server.col.service'), sortValue: (s) => s.description.toLowerCase(), cell: (s) => <span className="text-[13px] font-medium text-ink">{s.description}</span> },
    { key: 'output', header: t('server.col.output'), hideOnMobile: true, cell: (s) => <span className="text-xs break-words text-ink-2">{s.output}</span> },
    {
      key: 'check',
      header: t('server.col.check'),
      sortValue: (s) => s.lastCheck ?? 0,
      cell: (s) => {
        const d = epochSeconds(s.lastCheck);
        return d ? (
          <span className="text-xs whitespace-nowrap text-ink-2" title={formatDateTime(d, lang)}>
            {relativeTime(d, lang)}
          </span>
        ) : (
          <span className="text-xs text-ink-3">{t('common.none')}</span>
        );
      },
    },
  ];
  return (
    <Card title={t('server.services')} padded={false} className="min-w-0 lg:col-span-3">
      {off ? (
        <EmptyState compact icon={Activity} title={t('common.monitoringOff')} text={t('common.monitoringOffText')} />
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(s) => s.description}
          defaultSort={{ key: 'state', dir: 'asc' }}
          caption={t('server.services')}
          empty={<EmptyState compact icon={Activity} title={t('server.services.empty')} text={t('server.services.emptyText')} />}
        />
      )}
    </Card>
  );
}

function DocumentsCard({ server }: { server: ServerDetail }) {
  const { t } = useI18n();
  const docs = [...server.documents].sort((a, b) => Number(b.architecture) - Number(a.architecture) || a.name.localeCompare(b.name));
  return (
    <Card title={t('server.documents')} description={t('server.documents.desc')} padded={false} className="self-start lg:col-span-1">
      {docs.length === 0 ? (
        <EmptyState compact icon={FileText} title={t('server.documents.empty')} />
      ) : (
        <ul className="divide-y divide-line">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
              {d.url ? (
                <a href={d.url} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 text-[13px]">
                  {d.name}
                  <ExternalLink aria-hidden size={12} />
                </a>
              ) : (
                <span className="text-[13px] text-ink">{d.name}</span>
              )}
              {d.architecture && <Badge tone="accent">{t('appDetail.docs.architecture')}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryCard({ server }: { server: ServerDetail }) {
  const { t } = useI18n();
  // le serveur est nommé par son id dans les changements : on lui donne son nom lisible
  const labels = { [server.id]: server.name };
  return (
    <Card title={t('server.history')} description={t('server.history.desc')} padded={false} className="lg:col-span-2">
      {server.changes.length === 0 ? (
        <EmptyState compact icon={HistoryIcon} title={t('server.history.empty')} text={t('server.history.emptyText')} />
      ) : (
        <ol className="divide-y divide-line">
          {server.changes.map((c, i) => {
            const change = { ...c, labels };
            return (
              <li key={`${c.at}-${i}`} className="flex flex-col gap-2 px-4 py-3">
                <ChangeHeader change={change} />
                <ChangeDetail change={change} />
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
