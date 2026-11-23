/**
 * Page Équipes : une carte par équipe ou personne (applications, rôle, source, pages sources),
 * le groupe « Non renseignée » en dernier. Filtre texte (nom ou application) gardé dans l'adresse (?q=),
 * utilisé aussi par la palette Ctrl+K. Données : /api/teams.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Users, X } from 'lucide-react';
import { api, REFRESH_MS, useApi, type Team, type TeamApp } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { appHref } from '../lib/links';
import { normalize } from '../lib/search';
import { currentCount, filterTeams, isCurrent, orderTeams, roleKey, teamCounts } from '../lib/teams';
import { cn } from '../lib/cn';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonRows } from '../components/ui';
import { SearchInput } from '../components/filters';
import { Avatar, CriticalityDot, OwnerPeriodBadge, OwnerSourceBadge, SourcePages } from '../components/marks';

export default function TeamsPage() {
  const { t } = useI18n();
  useTitle(t('page.teams.title'));
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.teams({ signal }), [], { refreshMs: REFRESH_MS });
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const setQ = (v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set('q', v);
    else p.delete('q');
    setParams(p, { replace: true });
  };

  const ordered = useMemo(() => orderTeams(data ?? []), [data]);
  const shown = useMemo(() => filterTeams(ordered, q), [ordered, q]);
  const counts = teamCounts(data ?? []);
  const exact = normalize(q);

  return (
    <>
      <PageHeader
        title={t('page.teams.title')}
        subtitle={t('page.teams.subtitle')}
        meta={
          data && (
            <>
              <Badge>{t('teams.count.people', { n: counts.people })}</Badge>
              <Badge>{t('teams.count.teams', { n: counts.teams })}</Badge>
            </>
          )
        }
      />
      {error && data && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput value={q} onChange={setQ} placeholder={t('teams.search')} label={t('teams.search')} clearLabel={t('common.clearSearch')} className="sm:w-80" />
        {data && counts.unassigned > 0 && <span className="text-xs text-ink-3 sm:ml-auto">{t('teams.count.unassigned', { n: counts.unassigned })}</span>}
      </div>
      {loading ? (
        <div className="rounded-lg border border-line bg-surface">
          <SkeletonRows rows={8} />
        </div>
      ) : !data ? (
        <ErrorState error={error} onRetry={reload} retrying={refreshing} />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={Users} title={t('teams.empty')} text={t('teams.emptyText')} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={t('teams.noMatch')}
            text={t('teams.noMatchText')}
            action={
              <Button size="sm" icon={X} onClick={() => setQ('')}>
                {t('apps.filter.reset')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((team) =>
            team.kind === 'unassigned' ? (
              <UnassignedCard key="unassigned" team={team} />
            ) : (
              <TeamCard key={`${team.kind}:${team.id ?? team.name}`} team={team} highlight={exact !== '' && normalize(team.name) === exact} />
            ),
          )}
        </div>
      )}
    </>
  );
}

function TeamCard({ team, highlight }: { team: Team; highlight: boolean }) {
  const { t } = useI18n();
  const current = currentCount(team);
  const formerOnly = current === 0;
  return (
    <section
      aria-label={team.name}
      className={cn('min-w-0 rounded-lg border bg-surface', highlight ? 'border-accent ring-2 ring-accent/25' : 'border-line')}
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar name={team.name} kind={team.kind} muted={formerOnly} />
        <div className="min-w-0 flex-1">
          <h2 className={cn('truncate text-sm font-semibold', formerOnly ? 'text-ink-3' : 'text-ink')}>{team.name}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge>{t(team.kind === 'team' ? 'teams.kind.team' : 'teams.kind.person')}</Badge>
            {formerOnly && <OwnerPeriodBadge period="past" />}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tabular text-lg leading-6 font-semibold text-ink">{current}</div>
          <div className="text-2xs text-ink-3">{t('nav.applications')}</div>
        </div>
      </header>
      <ul className="divide-y divide-line">
        {team.applications.map((a) => (
          <TeamAppRow key={`${a.id}:${a.role}:${a.period}`} app={a} />
        ))}
      </ul>
    </section>
  );
}

function TeamAppRow({ app }: { app: TeamApp }) {
  const { t } = useI18n();
  const former = !isCurrent(app);
  const role = roleKey(app.role);
  return (
    <li className={cn('flex flex-col gap-1 px-4 py-2', former && 'bg-surface-2/50')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <CriticalityDot value={app.criticality} />
          <Link to={appHref(app.id)} className={cn('truncate text-[13px] font-medium', former ? 'text-ink-3 hover:underline' : 'link')}>
            {app.name}
          </Link>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {role && <span className={cn('text-xs', former ? 'text-ink-3' : 'text-ink-2')}>{t(role)}</span>}
          <OwnerPeriodBadge period={app.period} />
          <OwnerSourceBadge source={app.source} />
        </span>
      </div>
      <SourcePages docs={app.docs} className={cn('pl-3.5', former && 'opacity-80')} />
    </li>
  );
}

function UnassignedCard({ team }: { team: Team }) {
  const { t } = useI18n();
  return (
    <section aria-label={t('teams.unassigned')} className="min-w-0 rounded-lg border border-dashed border-line-strong bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar name="" kind="unassigned" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{t('teams.unassigned')}</h2>
          <p className="text-xs text-ink-3">{t('teams.unassignedText')}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="tabular text-lg leading-6 font-semibold text-ink">{team.applications.length}</div>
          <div className="text-2xs text-ink-3">{t('nav.applications')}</div>
        </div>
      </header>
      <ul className="flex flex-wrap gap-2 p-4">
        {team.applications.map((a) => (
          <li key={a.id}>
            <Link
              to={appHref(a.id)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-ink transition-colors hover:border-line-strong hover:bg-surface-2"
            >
              <CriticalityDot value={a.criticality} />
              {a.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
