import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** titre de la carte (h2 visuellement discret) */
  title?: ReactNode;
  /** texte d'aide à droite du titre ou sous lui */
  description?: ReactNode;
  /** boutons ou liens alignés à droite de l'en-tête */
  actions?: ReactNode;
  /** false : le contenu va jusqu'aux bords (tableaux, listes) */
  padded?: boolean;
  children?: ReactNode;
}

/** Bloc de contenu sur fond « surface », avec en-tête facultatif. */
export function Card({ title, description, actions, padded = true, className, children, ...rest }: CardProps) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface', className)} {...rest}>
      {(title || actions) && (
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold text-ink">{title}</h2>}
            {description && <p className="text-xs text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}
