import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { TONE_CLASSES, type Tone } from '../../lib/status';

interface StatProps {
  label: string;
  /** null = donnée indisponible (affiche « Non connecté » ou `unavailable`, jamais un 0 trompeur) */
  value: ReactNode | null;
  unavailable?: string;
  hint?: ReactNode;
  icon?: LucideIcon;
  /** colore le chiffre et l'icône (ex. 'down' pour des pannes) */
  tone?: Tone;
  /** tuile cliquable vers une page */
  to?: string;
  className?: string;
}

/** Tuile de chiffre-clé : libellé, valeur, précision. */
export function Stat({ label, value, unavailable = '', hint, icon: Icon, tone, to, className }: StatProps) {
  const toneText = tone ? TONE_CLASSES[tone].text : 'text-ink';
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-2">{label}</span>
        {Icon && <Icon aria-hidden size={16} strokeWidth={1.75} className={tone ? toneText : 'text-ink-3'} />}
      </div>
      <div className={cn('tabular mt-1 text-2xl leading-8 font-semibold tracking-tight', value === null ? 'text-base text-ink-3' : toneText)}>
        {value === null ? unavailable : value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
    </>
  );
  const cls = cn('block rounded-lg border border-line bg-surface px-4 py-3', to && 'transition-colors hover:border-line-strong hover:bg-surface-2', className);
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
