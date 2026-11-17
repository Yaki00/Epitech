import { useState } from 'react';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { formatDateTime, timeAgo } from '../lib/format';
import { Card, EmptyState, ErrorBox, Spinner, StatCard } from '../components/ui';
import { ChevronIcon, SyncIcon } from '../components/Icons';

const STATUS = {
  success: { label: 'Succès', cls: 'bg-emerald-50 text-emerald-700' },
  partial: { label: 'Partiel', cls: 'bg-amber-50 text-amber-700' },
  error: { label: 'Échec', cls: 'bg-red-50 text-red-700' },
  running: { label: 'En cours', cls: 'bg-blue-50 text-blue-700' },
};

const SOURCE_NAMES = { marketplace: 'Marketplace', apm: 'APM', naemon: 'Naemon', confluence: 'Confluence', 'confluence+llm': 'Confluence + IA', servicenow: 'ServiceNow' };
const sourceName = (s) => SOURCE_NAMES[s] || s;

const STAT_LABELS = { rows: 'lignes', nodes: 'entités', relations: 'relations', pages: 'pages', skipped: 'inchangées', errors: 'erreurs', mentions: 'mentions', diagramLinks: 'liens draw.io', llmRelations: 'relations IA', unresolved: 'non résolus' };

function RunRow({ run }) {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState(null);
  const s = STATUS[run.status] || STATUS.running;
  const stats = Object.entries(run.stats || {}).filter(([k, v]) => STAT_LABELS[k] && typeof v === 'number');

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
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.cls}`}>{s.label}</span>
        </td>
        <td className="px-5 py-3 text-slate-600" title={formatDateTime(run.started_at)}>
          {timeAgo(run.started_at)}
        </td>
        <td className="px-5 py-3 text-slate-600">
          {stats.map(([k, v]) => (
            <span key={k} className={`mr-3 whitespace-nowrap ${k === 'errors' && v ? 'font-medium text-red-600' : ''}`}>
              {v} {STAT_LABELS[k]}
            </span>
          ))}
          {run.error && <span className="text-red-600">{run.error}</span>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-12 py-3">
            {!errors ? (
              <span className="text-sm text-slate-500">Chargement…</span>
            ) : !errors.length ? (
              <span className="text-sm text-slate-500">Aucune erreur enregistrée pour ce passage.</span>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                {errors.map((e) => (
                  <li key={e.id} className="text-slate-700">
                    <span className="text-slate-400">[{e.step}]</span> {e.ref && <b>{e.ref}</b>} — {e.message}
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

export default function SyncPage() {
  const { data: runs, error, loading, reload } = useApi(() => api.syncRuns(), []);
  const { data: health } = useApi(() => api.health(), []);

  const lastBySource = {};
  for (const r of runs || []) if (!lastBySource[r.source]) lastBySource[r.source] = r;

  return (
    <div className="mx-auto max-w-[1500px] pb-24">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Synchronisation</h1>
          <p className="mt-2 text-lg text-slate-500">État des sources de données et des derniers traitements</p>
        </div>
        <button onClick={reload} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium hover:bg-slate-50">
          <SyncIcon width={16} height={16} /> Actualiser
        </button>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-5 xl:grid-cols-4">
        <StatCard value={health?.counts?.application ?? '—'} label="Applications" />
        <StatCard value={health?.counts?.server ?? '—'} label="Serveurs" />
        <StatCard value={health?.counts?.database ?? '—'} label="Bases" />
        <StatCard value={health?.counts?.document ?? '—'} label="Pages Confluence" />
      </div>

      {Object.keys(lastBySource).length > 0 && (
        <div className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {Object.values(lastBySource).map((r) => {
            const s = STATUS[r.status] || STATUS.running;
            return (
              <Card key={r.source} className="p-5">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{sourceName(r.source)}</div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.cls}`}>{s.label}</span>
                </div>
                <div className="mt-2 text-sm text-slate-500">Dernier passage {timeAgo(r.finished_at || r.started_at)}</div>
              </Card>
            );
          })}
        </div>
      )}

      <h2 className="mt-10 text-xl font-semibold">Historique</h2>
      <div className="mt-4">
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading ? (
          <Spinner />
        ) : !runs.length ? (
          <EmptyState title="Aucune synchronisation">Lancez « npm run sync:inventory » puis « npm run sync:confluence » dans le backend.</EmptyState>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-5 py-3" />
                  <th className="px-5 py-3 font-medium">Source</th>
                  <th className="px-5 py-3 font-medium">Statut</th>
                  <th className="px-5 py-3 font-medium">Début</th>
                  <th className="px-5 py-3 font-medium">Résultat</th>
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
