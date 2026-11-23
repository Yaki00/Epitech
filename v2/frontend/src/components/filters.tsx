/**
 * Champs des barres de filtres : recherche, liste déroulante, case à cocher.
 * Mêmes hauteurs que les boutons (h-8.5) pour s'aligner dans une barre qui passe à la ligne.
 */
import { useId, type ReactNode } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../lib/cn';

const FIELD = 'h-8.5 rounded-md border border-line-strong bg-surface text-[13px] text-ink transition-colors hover:border-ink-3 focus-visible:border-accent';

/** Champ de recherche avec icône et bouton pour vider. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  clearLabel: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(FIELD, 'w-full pr-8 pl-8 placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={clearLabel}
          title={clearLabel}
          className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          <X aria-hidden size={14} />
        </button>
      )}
    </div>
  );
}

/** Liste déroulante native avec libellé visible (petit, au-dessus) ou seulement accessible. */
export function SelectField<V extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string }[];
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('relative min-w-0', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        title={label}
        className={cn(FIELD, 'w-full cursor-pointer appearance-none truncate pr-8 pl-2.5', value !== options[0]?.value && 'border-accent/60 bg-accent-soft')}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3" />
    </div>
  );
}

/** Case à cocher avec libellé (ex. « Afficher les retirés »). */
export function CheckToggle({ checked, onChange, children, className }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <label className={cn('inline-flex h-8.5 cursor-pointer items-center gap-2 text-[13px] whitespace-nowrap text-ink-2 select-none hover:text-ink', className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 cursor-pointer accent-[var(--color-accent)]" />
      {children}
    </label>
  );
}
