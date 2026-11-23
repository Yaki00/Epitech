/**
 * Légende de la carte : états (icône + libellé), types d'éléments, types de liens (dont à valider, ancien ou cible,
 * retiré), et la simulation quand elle est active.
 */
import { AppWindow, Database } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { TONE_CLASSES, stateMeta } from '../lib/status';
import { cn } from '../lib/cn';
import { edgeLook } from './edges';
import type { EdgeData } from './buildGraph';

const STATES = ['ok', 'warning', 'degraded', 'critical', 'down', 'maintenance', 'unknown', 'not_monitored'] as const;

function LineSample({ d }: { d: Pick<EdgeData, 'type' | 'retired' | 'mark' | 'env'> }) {
  const look = edgeLook(d);
  const arrow = look.marker && !d.retired && !d.mark;
  return (
    <svg aria-hidden width="34" height="10" viewBox="0 0 34 10" className="shrink-0 overflow-visible">
      <line
        x1="1"
        y1="5"
        x2={arrow ? 26 : 33}
        y2="5"
        style={{ stroke: look.stroke, strokeWidth: Math.max(1.4, look.width), strokeDasharray: look.dash, strokeLinecap: look.dash?.startsWith('0.5') ? 'round' : undefined, opacity: Math.max(0.8, look.opacity) }}
      />
      {arrow && <path d="M25,1.5 L33,5 L25,8.5 z" style={{ fill: look.stroke }} />}
    </svg>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-full text-2xs font-semibold tracking-wide text-ink-3 uppercase sm:w-auto">{title}</span>
      {children}
    </div>
  );
}

const Item = ({ children }: { children: React.ReactNode }) => <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">{children}</span>;

export function MapLegend({ simulation }: { simulation: boolean }) {
  const { t } = useI18n();
  return (
    <details open className="group border-t border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-xs font-semibold text-ink-2 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
        {t('map.legend.title')}
      </summary>
      <div className="flex flex-col gap-2.5 px-4 pb-3 lg:flex-row lg:flex-wrap lg:gap-x-8">
        <Group title={t('map.legend.states')}>
          {STATES.map((s) => {
            const m = stateMeta(s);
            const Icon = m.icon;
            return (
              <Item key={s}>
                <Icon aria-hidden size={13} strokeWidth={2.25} className={TONE_CLASSES[m.tone].text} />
                {t(m.labelKey)}
              </Item>
            );
          })}
        </Group>
        <Group title={t('map.legend.nodes')}>
          <Item>
            <span aria-hidden className="inline-flex h-4 w-6 items-center rounded-[4px] border border-line bg-surface pl-0.5">
              <span className="h-2.5 w-0.5 rounded-full bg-ok" />
            </span>
            <AppWindow aria-hidden size={12} className="-ml-0.5 text-ink-3" />
            {t('type.application')}
          </Item>
          <Item>
            <span aria-hidden className="inline-block h-3.5 w-6 rounded-[3px] border border-line bg-surface" />
            {t('type.server')}
          </Item>
          <Item>
            <span aria-hidden className="inline-flex h-3.5 w-6 items-center justify-center rounded-full border border-line bg-surface-2">
              <Database size={9} className="text-ink-2" />
            </span>
            {t('type.database')}
          </Item>
        </Group>
        <Group title={t('map.legend.edges')}>
          <Item>
            <LineSample d={{ type: 'runs_on', retired: false, env: 'PRD' }} />
            <span title={t('map.edge.runs_on.long')}>{t('map.edge.runs_on')}</span>
          </Item>
          <Item>
            <LineSample d={{ type: 'calls', retired: false }} />
            <span title={t('map.edge.calls.long')}>{t('map.edge.calls')}</span>
          </Item>
          <Item>
            <LineSample d={{ type: 'uses_db', retired: false }} />
            <span title={t('map.edge.uses_db.long')}>{t('map.edge.uses_db')}</span>
          </Item>
          <Item>
            <LineSample d={{ type: 'calls', retired: false, mark: 'toValidate' }} />
            <span title={t('trust.toValidate.hint')}>{t('map.edge.toValidate')}</span>
          </Item>
          <Item>
            <LineSample d={{ type: 'calls', retired: false, mark: 'past' }} />
            <span title={t('trust.past.hint')}>{t('map.edge.pastTarget')}</span>
          </Item>
          <Item>
            <LineSample d={{ type: 'calls', retired: true }} />
            <span title={t('trust.retired.hint')}>{t('map.edge.retired')}</span>
          </Item>
        </Group>
        {simulation && (
          <Group title={t('map.legend.sim')}>
            <Item>
              <span aria-hidden className="inline-block h-3.5 w-6 rounded-[3px] border border-line bg-surface ring-2 ring-down ring-offset-1 ring-offset-surface" />
              {t('map.legend.origin')}
            </Item>
            <Item>
              <span aria-hidden className="inline-block h-3.5 w-6 rounded-[3px] border border-line bg-surface ring-2 ring-accent ring-offset-1 ring-offset-surface" />
              {t('map.legend.impacted')}
            </Item>
            <Item>
              <span aria-hidden className={cn('inline-block h-3.5 w-6 rounded-[3px] border border-line bg-surface opacity-30')} />
              {t('map.legend.dim')}
            </Item>
          </Group>
        )}
      </div>
    </details>
  );
}
