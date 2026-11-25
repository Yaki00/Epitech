/**
 * Petites marques partagées : confiance et période d'un lien, « Hors inventaire », avatar à initiales,
 * pastille de criticité, source d'un responsable et lien vers sa page source.
 */
import { ExternalLink, FileSearch } from 'lucide-react';
import type { AppOwner, OwnerSource, TeamApp } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { TONE_CLASSES } from '../lib/status';
import { LINK_MARK_META, linkMark, type LinkMarkInput } from '../lib/trust';
import { criticalityTone, initials } from '../lib/teams';
import { cn } from '../lib/cn';
import { Badge } from './ui';

/** Étiquette d'un lien inactif (à valider, ancien, cible, autre application, retiré) ; rien s'il est actif. */
export function LinkMarkBadge({ item }: { item: LinkMarkInput }) {
  const { t } = useI18n();
  const mark = linkMark(item);
  if (!mark) return null;
  const meta = LINK_MARK_META[mark];
  return (
    <Badge tone={meta.tone} title={t(meta.hintKey)}>
      {t(meta.labelKey)}
    </Badge>
  );
}

/** Serveur cité par la documentation et absent des inventaires. */
export function OutOfInventoryBadge() {
  const { t } = useI18n();
  return (
    <Badge icon={FileSearch} title={t('server.outOfInventory.hint')}>
      {t('server.outOfInventory')}
    </Badge>
  );
}

/** Avatar rond à initiales ; `?` pour le groupe sans responsable. */
export function Avatar({ name, kind, size = 'md', muted = false }: { name: string; kind: 'person' | 'team' | 'unassigned'; size?: 'sm' | 'md'; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold select-none',
        size === 'md' ? 'size-10 text-sm' : 'size-7 text-2xs',
        // équipes en carré arrondi, personnes en rond
        kind === 'team' ? 'rounded-lg' : 'rounded-full',
        muted || kind === 'unassigned' ? 'bg-surface-3 text-ink-3' : kind === 'team' ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-ink-2',
      )}
    >
      {kind === 'unassigned' ? '?' : initials(name)}
    </span>
  );
}

/** Pastille de criticité (avec texte pour les lecteurs d'écran). */
export function CriticalityDot({ value }: { value: string | null }) {
  const { t } = useI18n();
  const label = value ? t('teams.criticality', { c: value }) : `${t('appDetail.fact.criticality')}${t('common.colon')} ${t('common.notSpecified')}`;
  return (
    <span title={label} className="inline-flex shrink-0 items-center">
      <span aria-hidden className={cn('size-2 rounded-full', TONE_CLASSES[criticalityTone(value)].dot)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Source d'un responsable : documentation ou APM. */
export function OwnerSourceBadge({ source }: { source: OwnerSource | null }) {
  const { t } = useI18n();
  if (!source) return null;
  return (
    <Badge tone={source === 'doc' ? 'accent' : 'neutral'} title={t(`teams.source.${source}.hint`)}>
      {t(`teams.source.${source}`)}
    </Badge>
  );
}

/**
 * « Ancien » ou « Cible » pour un responsable lu dans une page ancienne ou cible ; « À valider » pour une page
 * dont la période n'a pas pu être lue (`null`). Rien pour un responsable actuel.
 */
export function OwnerPeriodBadge({ period }: { period: AppOwner['period'] | TeamApp['period'] | undefined }) {
  const { t } = useI18n();
  if (period === 'past') return <Badge title={t('teams.former.hint')}>{t('teams.former')}</Badge>;
  if (period === 'target') return <Badge title={t('teams.target.hint')}>{t('teams.target')}</Badge>;
  if (period === null) return <Badge tone="warn" title={t('teams.unknownPeriod.hint')}>{t('teams.unknownPeriod')}</Badge>;
  return null;
}

/** Pages sources (lien externe, nouvel onglet). */
export function SourcePages({ docs, className }: { docs: { id: string; title: string; url: string | null }[]; className?: string }) {
  const { t } = useI18n();
  if (!docs.length) return null;
  return (
    <ul className={cn('flex min-w-0 flex-col gap-0.5', className)} aria-label={t('teams.sourcePage')}>
      {docs.map((d) => (
        <li key={d.id} className="min-w-0 text-xs">
          {d.url ? (
            <a href={d.url} target="_blank" rel="noreferrer noopener" className="link inline-flex max-w-full items-center gap-1" title={t('teams.sourcePage')}>
              <ExternalLink aria-hidden size={11} className="shrink-0" />
              <span className="truncate">{d.title}</span>
            </a>
          ) : (
            <span className="inline-flex max-w-full items-center gap-1 text-ink-3">
              <span className="truncate">{d.title}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
