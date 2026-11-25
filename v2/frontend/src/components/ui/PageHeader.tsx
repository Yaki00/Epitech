import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** lien de retour au-dessus du titre (ex. fiche → liste) */
  back?: { to: string; label: string };
  /** éléments à côté du titre (état, badges) */
  meta?: ReactNode;
  /** boutons alignés à droite */
  actions?: ReactNode;
}

/** En-tête de page : titre (h1), sous-titre, retour, actions. */
export function PageHeader({ title, subtitle, back, meta, actions }: PageHeaderProps) {
  return (
    <div className="mb-5">
      {back && (
        <Link to={back.to} className="mb-1.5 inline-flex items-center gap-0.5 text-xs text-ink-2 hover:text-ink">
          <ChevronLeft aria-hidden size={14} />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl leading-7 font-semibold tracking-tight text-ink">{title}</h1>
            {meta}
          </div>
          {subtitle && <p className="mt-0.5 max-w-3xl text-[13px] text-ink-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
