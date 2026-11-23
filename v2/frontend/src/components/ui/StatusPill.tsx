import { cn } from '../../lib/cn';
import { useI18n } from '../../lib/i18n';
import { TONE_CLASSES, stateMeta } from '../../lib/status';

interface StatusPillProps {
  /** état serveur ou application ; valeur absente ou inconnue = « Inconnu » */
  state: string | null | undefined;
  size?: 'sm' | 'md';
  /** icône seule (tableaux denses, carte) : le libellé reste lu par les lecteurs d'écran et en infobulle */
  iconOnly?: boolean;
  /** alerte prise en charge dans Naemon : affichée en retrait */
  ack?: boolean;
  className?: string;
}

/** État : couleur + icône + libellé (jamais la couleur seule). */
export function StatusPill({ state, size = 'md', iconOnly = false, ack = false, className }: StatusPillProps) {
  const { t } = useI18n();
  const meta = stateMeta(state);
  const c = TONE_CLASSES[meta.tone];
  const Icon = meta.icon;
  const label = t(meta.labelKey) + (ack ? ` (${t('state.ack')})` : '');
  if (iconOnly) {
    return (
      <span role="img" aria-label={label} title={label} className={cn('inline-flex shrink-0', c.text, ack && 'opacity-60', className)}>
        <Icon aria-hidden size={size === 'sm' ? 14 : 16} strokeWidth={2} />
      </span>
    );
  }
  return (
    <span
      title={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-1.5 text-2xs' : 'h-6 px-2 text-xs',
        c.text,
        c.soft,
        c.border,
        ack && 'opacity-70',
        className,
      )}
    >
      <Icon aria-hidden size={size === 'sm' ? 12 : 14} strokeWidth={2} />
      {t(meta.labelKey)}
      {ack && <span className="font-normal text-ink-3">{t('state.ack')}</span>}
    </span>
  );
}

/** Petite pastille de couleur (légendes, carte) ; toujours accompagnée d'un texte visible ailleurs. */
export function StatusDot({ state, className }: { state: string | null | undefined; className?: string }) {
  const meta = stateMeta(state);
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE_CLASSES[meta.tone].dot, className)} />;
}
