import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { CRITICALITY, normalizeCriticality, initials } from '../lib/format';
import { Card, EmptyState, ErrorBox, Spinner } from '../components/ui';
import { useI18n } from '../lib/i18n';

export default function TeamPage() {
  const { t: tr } = useI18n();
  const { data: teams, error, loading, reload } = useApi(() => api.teams(), []);

  return (
    <div className="mx-auto max-w-[1500px] pb-24">
      <h1 className="text-4xl font-bold tracking-tight">{tr('team.title')}</h1>
      <p className="mt-2 text-lg text-slate-500">{tr('team.subtitle')}</p>

      <div className="mt-8">
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading ? (
          <Spinner />
        ) : !teams.length ? (
          <EmptyState title={tr('team.empty')}>{tr('team.emptyText')}</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            {teams.map((t) => (
              <Card key={t.name} className="p-6">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 font-semibold text-blue-700">{t.unassigned ? '?' : initials(t.name.replace(/^(équipe|equipe|team)\s+/i, ''))}</div>
                  <div className="min-w-0">
                    <div className="truncate text-lg font-medium">{t.unassigned ? tr('team.unassigned') : t.name}</div>
                    <div className="truncate text-sm text-slate-500">{t.owners.length ? t.owners.join(', ') : tr('team.noOwner')}</div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-2xl font-bold">{t.applications.length}</div>
                    <div className="text-xs text-slate-500">{tr('team.apps')}</div>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  {t.applications.map((a) => {
                    const c = CRITICALITY[normalizeCriticality(a.criticality)];
                    return (
                      <Link key={a.id} to={`/app/${encodeURIComponent(a.id)}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-sm hover:border-blue-300 hover:bg-blue-50">
                        <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                        {a.name}
                      </Link>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
