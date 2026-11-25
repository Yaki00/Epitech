import { useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface TabItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** compteur affiché après le libellé (null = rien) */
  count?: number | null;
  disabled?: boolean;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** préfixe des ids : le panneau associé doit avoir id=`${idPrefix}-panel-${id}` et aria-labelledby=`${idPrefix}-tab-${id}` */
  idPrefix?: string;
  label?: string;
  className?: string;
}

/** Onglets (rôle ARIA tablist, flèches gauche/droite). Le contenu du panneau est rendu par la page. */
export function Tabs({ tabs, value, onChange, idPrefix = 'tabs', label, className }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.filter((tab) => !tab.disabled);

  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = enabled.findIndex((tab) => tab.id === value);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % enabled.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const target = enabled[next];
    if (!target) return;
    onChange(target.id);
    refs.current[tabs.indexOf(target)]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey} className={cn('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map((tab, i) => {
        const active = tab.id === value;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${tab.id}`}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              '-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] whitespace-nowrap transition-colors disabled:opacity-40',
              active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {Icon && <Icon aria-hidden size={15} strokeWidth={1.75} />}
            {tab.label}
            {tab.count !== undefined && tab.count !== null && (
              <span className="tabular rounded-sm bg-surface-3 px-1 text-2xs leading-4 text-ink-2">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
