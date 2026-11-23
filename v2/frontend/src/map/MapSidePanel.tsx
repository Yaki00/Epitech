/**
 * Panneau latéral de la carte :
 * - en simulation : éléments en panne (retirables), éléments touchés groupés par type avec niveau et chemin,
 *   export CSV, effacement de la sélection ;
 * - hors simulation : fiche courte de l'élément choisi (état, environnement, liens, « Simuler sa panne »).
 */
import { Link } from 'react-router';
import { AppWindow, Database, Download, Eraser, Network, Server as ServerIcon, X, Zap, type LucideIcon } from 'lucide-react';
import type { MapData, MapNode, SimulateResult } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { appHref, appMapHref, serverHref } from '../lib/links';
import { cn } from '../lib/cn';
import { Badge, Button, EmptyState, EnvBadge, StatusPill } from '../components/ui';
import { LinkMarkBadge, OutOfInventoryBadge } from '../components/marks';

const TYPE_ICON: Record<string, LucideIcon> = { application: AppWindow, server: ServerIcon, database: Database };
const GROUPS = ['application', 'server', 'database'] as const;

const hrefOf = (id: string, type: string): string | null => (type === 'application' ? appHref(id) : type === 'server' ? serverHref(id) : null);

function ItemName({ id, type, name, className }: { id: string; type: string; name: string; className?: string }) {
  const href = hrefOf(id, type);
  const cls = cn('truncate', type === 'server' ? 'font-mono text-xs' : 'text-[13px]', className);
  return href ? (
    <Link to={href} className={cn('link', cls)}>
      {name}
    </Link>
  ) : (
    <span className={cn('text-ink', cls)}>{name}</span>
  );
}

export interface SimPanelProps {
  selected: string[];
  nodeOf: (id: string) => MapNode | undefined;
  stateOf: (id: string) => string | null;
  /** ids dessinés sur la carte (les autres sont signalés « Hors carte ») */
  onMap: Set<string>;
  result: SimulateResult | null;
  loading: boolean;
  error: Error | null;
  includeRetired: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
  onExport: () => void;
  onExit: () => void;
}

export function SimPanel({ selected, nodeOf, stateOf, onMap, result, loading, error, includeRetired, onRemove, onClear, onExport, onExit }: SimPanelProps) {
  const { t } = useI18n();
  const impacted = result?.impacted ?? [];
  const nameOf = (id: string) => nodeOf(id)?.label ?? impacted.find((i) => i.id === id)?.name ?? id;
  const linkLabel = (type: string) => (['runs_on', 'calls', 'uses_db'].includes(type) ? t(`map.edge.${type}` as 'map.edge.calls') : type);
  const groups = [...GROUPS, 'other' as const]
    .map((g) => ({ g, items: impacted.filter((i) => (g === 'other' ? !GROUPS.includes(i.type as (typeof GROUPS)[number]) : i.type === g)) }))
    .filter((x) => x.items.length);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-down-soft text-down">
          <Zap size={13} strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink">{t('map.sim.title')}</h2>
          <p className="text-xs text-ink-2">{t('map.sim.hint')}</p>
        </div>
        <Button variant="ghost" size="sm" iconOnly icon={X} label={t('map.sim.exit')} onClick={onExit} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected.length === 0 ? (
          <EmptyState compact icon={Zap} title={t('map.sim.emptyTitle')} text={t('map.sim.emptyText')} />
        ) : (
          <>
            <section className="border-b border-line px-4 py-3">
              <h3 className="mb-2 text-xs font-semibold text-down">{t('map.sim.selected', { n: selected.length })}</h3>
              <ul className="flex flex-wrap gap-1.5">
                {selected.map((id) => {
                  const n = nodeOf(id);
                  const Icon = TYPE_ICON[n?.type ?? ''] ?? Network;
                  const name = nameOf(id);
                  return (
                    <li key={id} className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-down/40 bg-down-soft pr-0.5 pl-2 text-xs text-ink">
                      <Icon aria-hidden size={13} className="shrink-0 text-down" />
                      <span className={cn('truncate', n?.type === 'server' && 'font-mono')}>{name}</span>
                      <button
                        type="button"
                        onClick={() => onRemove(id)}
                        aria-label={t('map.sim.remove', { name })}
                        title={t('map.sim.remove', { name })}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-down/15 hover:text-ink"
                      >
                        <X aria-hidden size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="px-4 py-3" aria-live="polite" aria-busy={loading}>
              {error ? (
                <p role="alert" className="text-xs text-down">
                  {t('map.sim.error')}
                  {t('common.colon')} {error.message}
                </p>
              ) : !result ? (
                <p className="text-xs text-ink-3">{t('map.sim.running')}</p>
              ) : (
                <>
                  <p className={cn('mb-2 flex items-baseline gap-2', loading && 'opacity-60')}>
                    <span className="text-2xl font-semibold text-accent tabular">{impacted.length}</span>
                    <span className="text-xs text-ink-2">{t('map.sim.impactedWord', { n: impacted.length })}</span>
                  </p>
                  {impacted.length === 0 && <p className="text-xs text-ink-2">{t('map.sim.noneImpacted')}</p>}
                  {groups.map(({ g, items }) => (
                    <div key={g} className="mt-3 first:mt-1">
                      <h3 className="mb-1 flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
                        {t(`map.group.${g}` as 'map.group.server')}
                        <span className="tabular">{items.length}</span>
                      </h3>
                      <ul className="divide-y divide-line rounded-md border border-line">
                        {items.map((i) => {
                          const node = nodeOf(i.id);
                          return (
                            <li key={i.id} className="flex flex-col gap-0.5 px-2.5 py-1.5">
                              <span className="flex min-w-0 items-center gap-1.5">
                                {i.type !== 'database' && <StatusPill state={stateOf(i.id)} size="sm" iconOnly />}
                                <ItemName id={i.id} type={i.type} name={i.name} className="min-w-0" />
                                {node?.type === 'server' && <EnvBadge env={node.env} />}
                                {!onMap.has(i.id) && (
                                  <span title={t('map.sim.offMapTitle')} className="ml-auto shrink-0">
                                    <Badge>{t('map.sim.offMap')}</Badge>
                                  </span>
                                )}
                              </span>
                              <span className="truncate text-2xs text-ink-3">
                                {t('map.sim.depth', { n: i.depth })}
                                {i.via && ` · ${t('map.sim.via', { name: nameOf(i.via.from), link: linkLabel(i.via.edgeType) })}`}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                  {!!result.unknown.length && <p className="mt-3 text-2xs text-ink-3">{t('map.sim.unknown', { n: result.unknown.length })}</p>}
                  {includeRetired && <p className="mt-3 text-2xs text-ink-3">{t('map.sim.withRetired')}</p>}
                </>
              )}
            </section>
          </>
        )}
      </div>

      <footer className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
        <Button size="sm" variant="primary" icon={Download} onClick={onExport} disabled={!selected.length || !result}>
          {t('map.sim.exportCsv')}
        </Button>
        <Button size="sm" icon={Eraser} onClick={onClear} disabled={!selected.length}>
          {t('map.sim.clear')}
        </Button>
      </footer>
    </div>
  );
}

export interface DetailPanelProps {
  node: MapNode;
  state: string | null;
  map: MapData;
  scope: string;
  onClose: () => void;
  onSimulate: () => void;
}

export function DetailPanel({ node, state, map, scope, onClose, onSimulate }: DetailPanelProps) {
  const { t } = useI18n();
  const Icon = TYPE_ICON[node.type] ?? Network;
  const href = hrefOf(node.id, node.type);
  const label = (id: string) => map.nodes.find((n) => n.id === id)?.label ?? id;
  const neighbours = (type: string, dir: 'out' | 'in') =>
    map.edges.filter((e) => e.type === type && (dir === 'out' ? e.source === node.id : e.target === node.id)).map((e) => (dir === 'out' ? e.target : e.source));
  // lien inactif vers un voisin (à valider, ancien, cible, retiré) : étiquette à côté de son nom
  const edgeTo = (id: string, key: string) =>
    map.edges.find((e) => {
      const type = key === 'apps' ? (node.type === 'server' ? 'runs_on' : 'uses_db') : key === 'db' ? 'uses_db' : 'calls';
      return e.type === type && ((e.source === node.id && e.target === id) || (e.target === node.id && e.source === id));
    });
  const rows: { key: string; title: string; ids: string[] }[] =
    node.type === 'server'
      ? [{ key: 'apps', title: t('map.detail.hostedApps'), ids: neighbours('runs_on', 'in') }]
      : node.type === 'database'
        ? [{ key: 'apps', title: t('map.group.application'), ids: neighbours('uses_db', 'in') }]
        : [
            { key: 'calls', title: t('map.detail.calls'), ids: neighbours('calls', 'out') },
            { key: 'calledBy', title: t('map.detail.calledBy'), ids: neighbours('calls', 'in') },
            { key: 'db', title: t('map.group.database'), ids: neighbours('uses_db', 'out') },
          ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <Icon aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-2" />
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium tracking-wide text-ink-3 uppercase">{t(`type.${node.type}` as 'type.server')}</p>
          <h2 className={cn('truncate font-semibold text-ink', node.type === 'server' ? 'font-mono text-[13px]' : 'text-sm')}>{node.label}</h2>
        </div>
        <Button variant="ghost" size="sm" iconOnly icon={X} label={t('common.close')} onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {node.type !== 'database' && <StatusPill state={state} size="sm" />}
          {node.type === 'server' && <EnvBadge env={node.env} long />}
          {node.criticality && (
            <Badge title={t('map.criticality')}>
              {t('map.criticality')}
              {t('common.colon')} {node.criticality}
            </Badge>
          )}
          {node.retired && <Badge>{t('common.retired')}</Badge>}
          {node.outOfInventory && <OutOfInventoryBadge />}
        </div>
        {rows.map((r) =>
          r.ids.length ? (
            <div key={r.key}>
              <h3 className="mb-1 text-2xs font-semibold tracking-wide text-ink-3 uppercase">{r.title}</h3>
              <ul className="space-y-0.5">
                {r.ids.map((id) => {
                  const n = map.nodes.find((x) => x.id === id);
                  return (
                    <li key={id} className="flex min-w-0 items-center gap-1.5">
                      <ItemName id={id} type={n?.type ?? ''} name={label(id)} />
                      {n?.type === 'server' && <EnvBadge env={n.env} />}
                      {edgeTo(id, r.key) && <LinkMarkBadge item={edgeTo(id, r.key)!} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null,
        )}
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
        <Button size="sm" variant="primary" icon={Zap} onClick={onSimulate}>
          {t('map.detail.simulate')}
        </Button>
        {href && (
          <Button size="sm" to={href}>
            {t('map.detail.open')}
          </Button>
        )}
        {node.type === 'application' && scope !== `app:${node.id}` && (
          <Button size="sm" icon={Network} to={appMapHref(node.id)}>
            {t('map.detail.appMap')}
          </Button>
        )}
      </footer>
    </div>
  );
}
