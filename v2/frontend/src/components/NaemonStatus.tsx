/**
 * Carte « Relève Naemon » (pages Supervision et Synchronisation) : source, dernier succès, prochaine relève,
 * dernière erreur expliquée. Source coupée : comment la brancher (jamais de zéros trompeurs).
 * Données : relève partagée /api/status (relue chaque minute).
 */
import type { ReactNode } from 'react';
import { Activity, CircleAlert, RefreshCw } from 'lucide-react';
import type { Key } from '../lib/i18n';
import { useI18n } from '../lib/i18n';
import { useLiveStatus } from '../lib/live';
import { useConfig } from '../lib/config';
import { formatDateTime, relativeTime, untilTime } from '../lib/format';
import { naemonErrorKind, naemonHealth } from '../lib/monitoring';
import { sourceStatus } from '../lib/sources';
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonRows } from './ui';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="text-[13px] text-ink">{children}</dd>
    </div>
  );
}

export function NaemonStatusCard({ className }: { className?: string }) {
  const { t, lang } = useI18n();
  const { status, error, reload } = useLiveStatus();
  const { config } = useConfig();
  const health = status ? naemonHealth(status, Boolean(config?.demo)) : null;
  const badge = health ? sourceStatus(t, health === 'demo' ? 'démo' : health) : null;
  const kind = naemonErrorKind(status?.lastError);

  return (
    <Card
      className={className}
      title={t('naemon.title')}
      description={t('naemon.desc')}
      actions={
        <>
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          <Button size="sm" variant="ghost" icon={RefreshCw} iconOnly label={t('common.refresh')} onClick={reload} />
        </>
      }
    >
      {!status ? (
        error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : (
          <SkeletonRows rows={3} />
        )
      ) : status.source === 'off' ? (
        <EmptyState compact icon={Activity} title={t('common.monitoringOff')} text={t('naemon.offText')} />
      ) : (
        <>
          <dl className="divide-y divide-line">
            <Row label={t('naemon.source')}>{t(`naemon.source.${status.source}` as Key)}</Row>
            <Row label={t('naemon.lastOk')}>
              <span title={status.lastOk ? formatDateTime(status.lastOk, lang) : undefined}>{relativeTime(status.lastOk, lang)}</span>
            </Row>
            <Row label={t('naemon.nextAt')}>
              <span title={status.nextAt ? formatDateTime(status.nextAt, lang) : undefined}>{status.nextAt ? untilTime(status.nextAt, lang) : t('common.none')}</span>
            </Row>
          </dl>
          {status.lastError && kind && (
            <div role="alert" className="mt-3 flex gap-2.5 rounded-md border border-down/30 bg-down-soft px-3 py-2.5">
              <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-down" />
              <div className="min-w-0 text-xs">
                <p className="font-medium text-ink">{t('naemon.lastError')}</p>
                <p className="mt-0.5 font-mono break-words text-ink-2">{status.lastError}</p>
                <p className="mt-1.5 text-ink">{t(`naemon.err.${kind}` as Key)}</p>
                <p className="mt-1 text-ink-3">{t('naemon.keptState')}</p>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
