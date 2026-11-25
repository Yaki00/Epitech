import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ENV_CLASSES, TONE_CLASSES, envKey, envLabelKey, envShortKey, type Tone } from '../../lib/status';
import { useI18n } from '../../lib/i18n';
import type { Env } from '../../lib/api';

export type BadgeTone = 'neutral' | 'accent' | Tone;

const toneClass = (tone: BadgeTone) => {
  if (tone === 'neutral') return 'text-ink-2 bg-surface-3 border-transparent';
  if (tone === 'accent') return 'text-accent bg-accent-soft border-transparent';
  const c = TONE_CLASSES[tone];
  return cn(c.text, c.soft, c.border);
};

interface BadgeProps {
  tone?: BadgeTone;
  icon?: LucideIcon;
  title?: string;
  className?: string;
  children: ReactNode;
}

/** Étiquette courte (criticité, source, « Retiré »...). */
export function Badge({ tone = 'neutral', icon: Icon, title, className, children }: BadgeProps) {
  return (
    <span title={title} className={cn('inline-flex h-5 max-w-full items-center gap-1 rounded-sm border px-1.5 text-2xs font-medium whitespace-nowrap', toneClass(tone), className)}>
      {Icon && <Icon aria-hidden size={12} strokeWidth={2} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Environnement d'un serveur : PRD / STG / DEV, ou « Non précisé » (null). Libellé long en infobulle. */
export function EnvBadge({ env, long = false, className }: { env: Env | null | undefined; long?: boolean; className?: string }) {
  const { t } = useI18n();
  const key = envKey(env);
  const c = ENV_CLASSES[key];
  return (
    <span
      title={t(envLabelKey(env))}
      className={cn('inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 text-2xs font-semibold whitespace-nowrap', c.text, c.soft, c.border, className)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', c.dot)} />
      {long ? t(envLabelKey(env)) : t(envShortKey(env))}
    </span>
  );
}
