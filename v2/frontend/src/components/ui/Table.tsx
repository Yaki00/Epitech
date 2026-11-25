import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface Column<T> {
  /** identifiant de colonne (tri) */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** valeur de tri ; absente = colonne non triable */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** largeur CSS (ex. '8rem', '20%') */
  width?: string;
  /** masquée sous 768 px de large */
  hideOnMobile?: boolean;
  className?: string;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** ligne cliquable : chemin interne vers la fiche (la cellule doit aussi contenir un vrai lien pour le clavier) */
  rowHref?: (row: T) => string | null | undefined;
  /** ligne atténuée (ex. élément retiré) */
  rowMuted?: (row: T) => boolean;
  /** tri initial */
  defaultSort?: SortState;
  /** affiché à la place du corps quand `rows` est vide */
  empty?: ReactNode;
  /** texte pour les lecteurs d'écran */
  caption?: string;
  className?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

/** Tri ascendant (dir = 1) ou descendant (dir = -1) ; valeurs absentes toujours en dernier. */
export function compareValues(a: unknown, b: unknown, dir: 1 | -1 = 1): number {
  const na = isEmpty(a);
  const nb = isEmpty(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return dir * (a - b);
  return dir * String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Tableau dense : en-tête collant, tri par colonne, lignes cliquables. */
export function Table<T>({ columns, rows, rowKey, rowHref, rowMuted, defaultSort, empty, caption, className }: TableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);
  const navigate = useNavigate();

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!col || !col.sortValue || !sort) return rows;
    const get = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => compareValues(get(a), get(b), dir));
  }, [rows, sort, columns]);

  const toggle = (key: string) =>
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const SortIcon = !active ? ArrowUpDown : sort?.dir === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'sticky top-0 z-[1] bg-surface-2 px-3 py-2 text-xs font-medium whitespace-nowrap text-ink-3',
                    ALIGN[c.align ?? 'left'],
                    c.hideOnMobile && 'hidden md:table-cell',
                  )}
                >
                  {c.sortValue ? (
                    <button type="button" onClick={() => toggle(c.key)} className={cn('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}>
                      {c.header}
                      <SortIcon aria-hidden size={12} className={active ? '' : 'opacity-40'} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length} className="p-0">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const href = rowHref?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  onClick={
                    href
                      ? (e) => {
                          // un clic sur un lien ou un bouton de la ligne garde son propre comportement
                          if ((e.target as HTMLElement).closest('a,button,input,label')) return;
                          navigate(href);
                        }
                      : undefined
                  }
                  className={cn('border-b border-line last:border-b-0', href && 'cursor-pointer hover:bg-surface-2', rowMuted?.(row) && 'text-ink-3')}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-3 py-2 align-middle', ALIGN[c.align ?? 'left'], c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
