/**
 * Nœuds de la cartographie : applications (nom, état, criticité), serveurs compacts (nom et icône d'état),
 * bases, et les groupes (bande « Applications », zones d'environnement).
 * L'état n'est jamais montré par la couleur seule : icône d'état et libellé (lecteur d'écran, infobulle).
 * Chaque élément est un bouton : le clic (souris ou clavier) remonte à la carte (onNodeClick).
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AppWindow, Database, Zap } from 'lucide-react';
import { cn } from '../lib/cn';
import { useI18n } from '../lib/i18n';
import { ENV_CLASSES, TONE_CLASSES, envKey, stateMeta } from '../lib/status';
import type { BandNode, ClusterNode, ItemData, ItemNode, ZoneNode } from './buildGraph';

const HANDLE = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent !opacity-0';

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className={HANDLE} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={HANDLE} />
    </>
  );
}

/** Classes de mise en avant communes : simulation (origine, touché, estompé) ou voisinage du nœud choisi. */
function emphasis(d: ItemData): string {
  if (d.sim === 'origin') return 'ring-[3px] ring-down ring-offset-2 ring-offset-canvas shadow-pop';
  if (d.sim === 'impacted') return 'ring-[3px] ring-accent ring-offset-2 ring-offset-canvas shadow-pop';
  if (d.sim === 'dim') return 'opacity-25 saturate-0';
  if (d.near) return 'ring-2 ring-accent/70 ring-offset-1 ring-offset-canvas';
  if (d.faded) return 'opacity-35';
  return '';
}

function useItemLabel(d: ItemData): string {
  const { t } = useI18n();
  const parts = [t(`type.${d.kind}`), d.label];
  if (d.kind !== 'database') parts.push(t(stateMeta(d.state).labelKey));
  if (d.kind === 'server') parts.push(t(`env.${envKey(d.node.env)}` as 'env.PRD'));
  if (d.node.criticality) parts.push(`${t('map.criticality')} ${d.node.criticality}`);
  if (d.retired) parts.push(t('common.retired'));
  if (d.node.outOfInventory) parts.push(t('server.outOfInventory'));
  if (d.sim === 'origin') parts.push(t('map.legend.origin'));
  if (d.sim === 'impacted') parts.push(t('map.legend.impacted'));
  return parts.join(', ');
}

function SimMark({ d }: { d: ItemData }) {
  if (d.sim !== 'origin') return null;
  return (
    <span aria-hidden className="absolute -top-2.5 -right-2.5 inline-flex size-5 items-center justify-center rounded-full bg-down text-white shadow-sm dark:text-canvas">
      <Zap size={12} strokeWidth={2.5} fill="currentColor" />
    </span>
  );
}

export const ApplicationNode = memo(function ApplicationNode({ data: d }: NodeProps<ItemNode>) {
  const { t } = useI18n();
  const meta = stateMeta(d.state);
  const tone = TONE_CLASSES[meta.tone];
  const Icon = meta.icon;
  const label = useItemLabel(d);
  return (
    <>
      <Handles />
      <button
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          'relative flex h-full w-full cursor-pointer flex-col justify-center gap-1 overflow-visible rounded-lg border bg-surface py-1.5 pr-2.5 pl-3.5 text-left shadow-sm transition-[opacity,box-shadow,filter] duration-200 hover:border-line-strong hover:shadow-md',
          d.retired ? 'border-dashed border-line-strong' : 'border-line',
          emphasis(d),
        )}
      >
        <span aria-hidden className={cn('absolute inset-y-1.5 left-1.5 w-1 rounded-full', d.retired ? 'bg-unmon' : tone.dot)} />
        <span className="flex min-w-0 items-center gap-1.5">
          <AppWindow aria-hidden size={14} className="shrink-0 text-ink-3" />
          <span className={cn('truncate text-[13px] leading-tight font-semibold', d.retired ? 'text-ink-3' : 'text-ink')}>{d.label}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium', tone.text, tone.soft, tone.border)}>
            <Icon aria-hidden size={11} strokeWidth={2.25} />
            {t(meta.labelKey)}
          </span>
          {d.node.criticality && (
            <span className="inline-flex h-5 min-w-0 items-center truncate rounded-full border border-line bg-surface-2 px-1.5 text-2xs text-ink-2">{d.node.criticality}</span>
          )}
          {d.retired && <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-3 px-1.5 text-2xs text-ink-3">{t('common.retired')}</span>}
        </span>
        <SimMark d={d} />
      </button>
    </>
  );
});

export const ServerNode = memo(function ServerNode({ data: d }: NodeProps<ItemNode>) {
  const meta = stateMeta(d.state);
  const tone = TONE_CLASSES[meta.tone];
  const Icon = meta.icon;
  const label = useItemLabel(d);
  const alert = meta.rank >= 4;
  return (
    <>
      <Handles />
      <button
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          'relative flex h-full w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 text-left transition-[opacity,box-shadow,filter] duration-200 hover:shadow-md',
          alert ? cn(tone.soft, tone.border) : 'border-line bg-surface hover:border-line-strong',
          d.retired && 'border-dashed',
          emphasis(d),
        )}
      >
        <Icon aria-hidden size={14} strokeWidth={2.25} className={cn('shrink-0', tone.text)} />
        <span className={cn('truncate font-mono text-xs', d.retired ? 'text-ink-3 line-through decoration-ink-3/50' : 'text-ink')}>{d.label}</span>
        <SimMark d={d} />
      </button>
    </>
  );
});

export const DatabaseNode = memo(function DatabaseNode({ data: d }: NodeProps<ItemNode>) {
  const label = useItemLabel(d);
  return (
    <>
      <Handles />
      <button
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          'relative flex h-full w-full cursor-pointer items-center gap-2 rounded-[14px] border bg-surface-2 px-3 text-left transition-[opacity,box-shadow,filter] duration-200 hover:border-line-strong hover:shadow-md',
          d.retired ? 'border-dashed border-line-strong' : 'border-line',
          emphasis(d),
        )}
      >
        <Database aria-hidden size={15} className="shrink-0 text-ink-2" />
        <span className={cn('truncate text-xs font-medium', d.retired ? 'text-ink-3' : 'text-ink')}>{d.label}</span>
        <SimMark d={d} />
      </button>
    </>
  );
});

export const ZoneGroup = memo(function ZoneGroup({ data }: NodeProps<ZoneNode>) {
  const { t } = useI18n();
  const c = ENV_CLASSES[data.env];
  return (
    <div className={cn('h-full w-full rounded-xl border-2', c.border, c.soft)}>
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', c.dot)} />
        <span className={cn('truncate text-sm font-semibold', c.text)}>{t(`env.${data.env}` as 'env.PRD')}</span>
        {data.env !== 'none' && <span className={cn('rounded-sm border px-1 text-2xs font-semibold tracking-wide', c.text, c.border)}>{t(`env.short.${data.env}` as 'env.short.PRD')}</span>}
        <span className="ml-auto shrink-0 text-xs text-ink-2 tabular">{t('count.servers', { n: data.count })}</span>
      </div>
      {data.env === 'none' && data.count > 0 && <p className="truncate px-3.5 text-2xs text-ink-3">{t('map.zone.noneHint')}</p>}
      {data.count === 0 && <p className="px-3.5 pt-6 text-center text-xs text-ink-3">{t('map.zone.empty')}</p>}
    </div>
  );
});

export const ClusterGroup = memo(function ClusterGroup({ data }: NodeProps<ClusterNode>) {
  const { t } = useI18n();
  const c = ENV_CLASSES[data.env];
  const label = data.appId ? data.label : t('map.cluster.noApp');
  return (
    <div
      title={`${label}, ${t('count.servers', { n: data.count })}`}
      className={cn(
        'h-full w-full cursor-pointer rounded-lg border bg-surface/55 transition-opacity duration-200 dark:bg-surface/40',
        c.border,
        data.dim && 'opacity-40',
        data.near && 'ring-2 ring-accent/60',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className={HANDLE} />
      <div className="flex h-6 min-w-0 items-center gap-1 px-2">
        <AppWindow aria-hidden size={11} className={cn('shrink-0', c.text)} />
        <span className="truncate text-2xs font-medium text-ink-2">{label}</span>
        <span className="ml-auto shrink-0 pl-1 text-2xs text-ink-3 tabular">{data.count}</span>
      </div>
    </div>
  );
});

export const BandGroup = memo(function BandGroup({ data }: NodeProps<BandNode>) {
  const { t } = useI18n();
  return (
    <div className="h-full w-full rounded-xl border border-line bg-surface-2/70">
      <div className="flex items-center gap-2 px-4 pt-3">
        <AppWindow aria-hidden size={15} className="text-ink-2" />
        <span className="text-sm font-semibold text-ink">{t('map.band.title')}</span>
        <span className="ml-auto text-xs text-ink-2 tabular">{t('map.band.counts', { a: data.applications, d: data.databases })}</span>
      </div>
    </div>
  );
});

export const nodeTypes = {
  application: ApplicationNode,
  server: ServerNode,
  database: DatabaseNode,
  zone: ZoneGroup,
  cluster: ClusterGroup,
  band: BandGroup,
};
