import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { TYPE_LABELS } from '../lib/format';
import GraphView, { GRAPH_COLORS } from '../components/GraphView';
import { AppAvatar, Card, CriticalityBadge, EmptyState, ErrorBox, NotConnected, SourcePill, Spinner, StatCard } from '../components/ui';
import { AlertIcon, ArrowLeftIcon, ChartIcon, ExternalIcon } from '../components/Icons';

/* ---------------------------------------------------------------- Description */

function InfoItem({ label, children }) {
  return (
    <div>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 font-medium text-slate-900">{children ?? <span className="font-normal text-slate-400">Non renseigné</span>}</div>
    </div>
  );
}

function DescriptionTab({ app, sources }) {
  return (
    <Card className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">À propos de</h2>
          <p className="mt-1 text-sm text-slate-500">Description et rôle de l'application</p>
        </div>
        <CriticalityBadge value={app.criticality} />
      </div>

      <h3 className="mt-8 text-lg font-semibold">Rôle principal</h3>
      {app.description && <p className="mt-2 leading-relaxed text-slate-700">{app.description}</p>}
      {app.summary ? (
        <div className="mt-3 rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-violet-600">Résumé IA</div>
          <p className="mt-1 whitespace-pre-line leading-relaxed text-slate-700">{app.summary}</p>
        </div>
      ) : (
        <p className="mt-3 text-sm italic text-slate-400">Résumé IA non disponible</p>
      )}

      <h3 className="mt-8 text-lg font-semibold">Informations</h3>
      <div className="mt-4 grid grid-cols-1 gap-x-16 gap-y-6 md:grid-cols-2">
        <InfoItem label="AUID (écosystème)">{app.attrs.auid}</InfoItem>
        <InfoItem label="Profil">{app.attrs.profile}</InfoItem>
        <InfoItem label="Confidentialité">{app.attrs.confidentiality}</InfoItem>
        <InfoItem label="Équipe support">{app.supportTeam}</InfoItem>
        <InfoItem label="Environnements">{app.environments.length ? app.environments.join(', ') : null}</InfoItem>
        <InfoItem label="Responsable">{app.owner}</InfoItem>
        <InfoItem label="Serveurs">{app.servers}</InfoItem>
        <InfoItem label="Bases de données">{app.databases}</InfoItem>
        <InfoItem label="Tickets ouverts">{sources.servicenow ? '—' : <span className="font-normal text-slate-400">ServiceNow non connecté</span>}</InfoItem>
      </div>

      {(app.callsList.length > 0 || app.usedBy.length > 0) && (
        <>
          <h3 className="mt-8 text-lg font-semibold">Échanges avec d'autres applications</h3>
          <div className="mt-4 grid grid-cols-1 gap-x-16 gap-y-6 md:grid-cols-2">
            <LinkList title="Appelle" items={app.callsList} />
            <LinkList title="Appelée par" items={app.usedBy} />
          </div>
        </>
      )}

      {app.documents.length > 0 && (
        <>
          <h3 className="mt-8 text-lg font-semibold">Documentation</h3>
          <ul className="mt-3 space-y-2">
            {app.documents.map((d) => (
              <li key={d.id}>
                {d.architecture && (
                  <span className="mr-2 rounded-md bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">Architecture</span>
                )}
                {d.url ? (
                  <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-blue-700 hover:underline">
                    {d.name} <ExternalIcon width={14} height={14} />
                  </a>
                ) : (
                  <span>{d.name}</span>
                )}
                {d.audit && <ArchitectureAudit audit={d.audit} />}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Contrôle d'une page d'architecture par rapport aux inventaires (APM, marketplace). */
function ArchitectureAudit({ audit }) {
  const ok = audit.verdict === 'cohérente avec les inventaires';
  const lines = [
    ['Manquants dans la page', audit.missing],
    ["Rattachés à une autre application", audit.otherApp],
    ['Inconnus des inventaires', audit.unknown],
    ['IP différentes', audit.ipMismatch],
    ['Rubriques absentes', audit.absentSections],
  ].filter(([, list]) => list && list.length);
  return (
    <div className={`mt-1.5 rounded-lg border px-3 py-2 text-sm ${ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
      <div className="font-medium text-slate-800">
        {audit.completeness !== null ? `${Math.round(audit.completeness * 100)} % des serveurs (${audit.confirmed.length}/${audit.expected})` : 'Serveurs de référence inconnus'}
        {audit.environment ? ` · ${audit.environment === 'prod' ? 'production' : 'hors production'}` : ''}
        <span className="font-normal text-slate-600"> · {audit.verdict}</span>
      </div>
      {lines.map(([label, list]) => (
        <div key={label} className="mt-1 text-slate-600">
          <span className="text-slate-500">{label} :</span> {list.join(', ')}
        </div>
      ))}
    </div>
  );
}

function LinkList({ title, items }) {
  return (
    <div>
      <div className="text-sm text-slate-500">{title}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.length ? (
          items.map((i) => (
            <Link key={i.id} to={`/app/${encodeURIComponent(i.id)}`} className="rounded-lg border border-slate-200 px-2.5 py-1 text-sm hover:border-blue-300 hover:bg-blue-50">
              {i.name}
            </Link>
          ))
        ) : (
          <span className="text-sm text-slate-400">Aucune</span>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Architecture */

function ArchitectureTab({ appId }) {
  const { data, error, loading, reload } = useApi(() => api.graph(appId, 2), [appId]);
  const [selected, setSelected] = useState(null);
  const [impact, setImpact] = useState(null);
  const [impactState, setImpactState] = useState({ loading: false, error: null });

  useEffect(() => {
    setSelected(null);
    setImpact(null);
  }, [appId]);

  async function simulate(node) {
    setImpactState({ loading: true, error: null });
    try {
      setImpact(await api.impact(node.id));
      setImpactState({ loading: false, error: null });
    } catch (err) {
      setImpactState({ loading: false, error: err });
    }
  }

  const highlight = useMemo(() => (impact ? { failing: impact.start.id, impacted: impact.items.map((i) => i.id) } : null), [impact]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading) return <Spinner label="Construction du graphe…" />;
  if (!data || data.nodes.length <= 1) return <EmptyState title="Aucune dépendance connue">Le graphe se remplit avec la marketplace, l'APM et l'analyse Confluence.</EmptyState>;

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
      <Card className="p-3">
        <GraphView elements={data} rootId={appId} highlight={highlight} onNodeClick={(n) => setSelected(n)} />
        <div className="flex flex-wrap items-center gap-4 px-3 pb-1 pt-3 text-xs text-slate-500">
          {['application', 'server', 'database', 'filesystem', 'queue'].map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: GRAPH_COLORS[t] }} />
              {TYPE_LABELS[t]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="w-5 border-t-2 border-dashed border-slate-400" /> lien déduit (confiance &lt; 100 %)
          </span>
        </div>
      </Card>

      <Card className="self-start p-5">
        <h3 className="font-semibold">Simulation d'impact</h3>
        {!selected ? (
          <p className="mt-2 text-sm text-slate-500">Cliquez sur un élément du graphe (serveur, base…) pour voir ce qui serait impacté s'il tombait.</p>
        ) : (
          <div className="mt-3">
            <div className="text-xs uppercase tracking-wide text-slate-400">{TYPE_LABELS[selected.type] || selected.type}</div>
            <div className="text-lg font-medium">{selected.label}</div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => simulate(selected)}
                disabled={impactState.loading}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <AlertIcon width={16} height={16} /> Simuler une panne
              </button>
              {impact && (
                <button onClick={() => setImpact(null)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  Effacer
                </button>
              )}
            </div>
          </div>
        )}
        {impactState.error && (
          <div className="mt-4">
            <ErrorBox error={impactState.error} />
          </div>
        )}
        {impact && (
          <div className="mt-5">
            <div className="text-sm text-slate-600">
              <span className="text-2xl font-bold text-red-600">{impact.total}</span> élément{impact.total > 1 ? 's' : ''} impacté{impact.total > 1 ? 's' : ''} si <b>{impact.start.name}</b> tombe
            </div>
            <ul className="mt-3 max-h-[300px] space-y-2 overflow-y-auto pr-1">
              {impact.items.map((i) => (
                <li key={i.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    {i.type === 'application' ? (
                      <Link to={`/app/${encodeURIComponent(i.id)}`} className="font-medium text-blue-700 hover:underline">
                        {i.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{i.name}</span>
                    )}
                    <span className="text-xs text-slate-400">niveau {i.depth}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    {TYPE_LABELS[i.type] || i.type} · {i.via.edgeType} <SourcePill source={i.via.source} confidence={i.via.confidence} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- Tableaux */

function NodeTable({ rows, columns, emptyTitle }) {
  if (!rows.length) return <EmptyState title={emptyTitle} />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="px-5 py-3 font-medium">
                {c.label}
              </th>
            ))}
            <th className="px-5 py-3 font-medium">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-slate-50">
              {columns.map((c) => (
                <td key={c.key} className="px-5 py-3">
                  {c.render ? c.render(r) : r.attrs[c.key] || <span className="text-slate-300">—</span>}
                </td>
              ))}
              <td className="px-5 py-3">
                <div className="flex flex-wrap gap-1">
                  {r.sources.map((s) => (
                    <SourcePill key={s} source={s} confidence={s === 'llm' ? r.confidence : undefined} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const SERVER_COLUMNS = [
  { key: 'name', label: 'Serveur', render: (r) => <span className="font-medium">{r.name}</span> },
  { key: 'ip', label: 'IP' },
  { key: 'environment', label: 'Env.' },
  { key: 'provisioner', label: 'Type' },
  { key: 'usedFor', label: 'Usage' },
  { key: 'os', label: 'OS' },
  { key: 'osVersion', label: 'Version' },
  { key: 'cpu', label: 'CPU' },
  { key: 'cpuCores', label: 'Cœurs' },
  { key: 'ram', label: 'RAM' },
  { key: 'country', label: 'Pays' },
];
const DB_COLUMNS = [
  { key: 'name', label: 'Base', render: (r) => <span className="font-medium">{r.name}</span> },
  { key: 'engine', label: 'Moteur' },
  { key: 'environment', label: 'Env.' },
];

/* ---------------------------------------------------------------- Page */

export default function ApplicationDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'description';
  const { data: app, error, loading, reload } = useApi(() => api.application(id), [id]);
  const { data: cfg } = useApi(() => api.config(), []);
  const sources = cfg?.sources || { servicenow: false, bitbucket: false };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !app) return <Spinner />;

  const tabs = [
    { key: 'description', label: 'Description' },
    { key: 'architecture', label: 'Architecture' },
    { key: 'servers', label: `Serveurs (${app.servers})` },
    { key: 'databases', label: `Bases (${app.databases})` },
    { key: 'tickets', label: 'Tickets' },
    { key: 'changes', label: 'Changements' },
    { key: 'prs', label: 'PRs' },
  ];
  const naemonUrl = cfg?.naemonUrlTemplate ? cfg.naemonUrlTemplate.replace('{app}', encodeURIComponent(app.name)) : null;
  const notConnected = 'non connecté';

  return (
    <div className="mx-auto max-w-[1500px] pb-24">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeftIcon width={16} height={16} /> Applications
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-5">
          <AppAvatar name={app.name} size="lg" solid />
          <h1 className="text-4xl font-bold tracking-tight">{app.name}</h1>
          <CriticalityBadge value={app.criticality} />
        </div>
        {naemonUrl ? (
          <a href={naemonUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-violet-700 px-5 py-3 font-medium text-white shadow-md shadow-violet-700/20 hover:bg-violet-800">
            <ChartIcon /> Monitoring Naemon
          </a>
        ) : (
          <span title="Définir NAEMON_URL_TEMPLATE dans le .env du backend" className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-violet-300 px-5 py-3 font-medium text-white">
            <ChartIcon /> Monitoring Naemon
          </span>
        )}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-5 lg:grid-cols-5">
        <StatCard value={app.servers} label="Serveurs" centered />
        <StatCard value={app.databases} label="Bases" centered />
        <StatCard value={sources.servicenow ? 0 : '—'} label="Tickets P1" accent="redText" hint={sources.servicenow ? null : notConnected} centered />
        <StatCard value={sources.servicenow ? 0 : '—'} label="Changements actifs" accent="orangeText" hint={sources.servicenow ? null : notConnected} centered />
        <StatCard value={sources.bitbucket ? 0 : '—'} label="PRs ouverts" accent="blue" hint={sources.bitbucket ? null : notConnected} centered />
      </div>

      <div className="mt-8 flex gap-1 overflow-x-auto border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams(t.key === 'description' ? {} : { tab: t.key }, { replace: true })}
            className={`-mb-px whitespace-nowrap border-b-2 px-5 py-3 text-[15px] font-medium transition ${
              tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'description' && <DescriptionTab app={app} sources={sources} />}
        {tab === 'architecture' && <ArchitectureTab appId={app.id} />}
        {tab === 'servers' && <NodeTable rows={app.serverList} columns={SERVER_COLUMNS} emptyTitle="Aucun serveur associé" />}
        {tab === 'databases' && <NodeTable rows={app.databaseList} columns={DB_COLUMNS} emptyTitle="Aucune base associée" />}
        {tab === 'tickets' && <NotConnected source="ServiceNow" />}
        {tab === 'changes' && <NotConnected source="ServiceNow" />}
        {tab === 'prs' && <NotConnected source="Bitbucket" />}
      </div>
    </div>
  );
}
