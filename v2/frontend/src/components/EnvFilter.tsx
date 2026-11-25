/**
 * Filtre d'environnements : PRD, STG, DEV (+ Non précisé). PRD et STG cochés par défaut, DEV décoché ;
 * le choix est mémorisé et partagé entre les pages (voir lib/envFilter.ts).
 */
import { ENVS, envKey } from '../lib/status';
import { toggleEnv, useEnvFilter } from '../lib/envFilter';
import { useI18n } from '../lib/i18n';
import type { Env } from '../lib/api';
import { cn } from '../lib/cn';

type Counts = Partial<Record<Env | 'none', number>>;

export function EnvFilter({ counts, className }: { counts?: Counts; className?: string }) {
  const { t } = useI18n();
  const [filter, setFilter] = useEnvFilter();
  const items: { key: Env | 'none'; checked: boolean; onChange: (v: boolean) => void }[] = [
    ...ENVS.map((e) => ({ key: e as Env | 'none', checked: filter.envs.includes(e), onChange: (v: boolean) => setFilter(toggleEnv(filter, e, v)) })),
    { key: 'none', checked: filter.unspecified, onChange: (v: boolean) => setFilter({ ...filter, unspecified: v }) },
  ];
  return (
    <fieldset className={cn('m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-0 p-0', className)}>
      <legend className="sr-only">{t('envFilter.label')}</legend>
      <span aria-hidden className="text-xs font-medium text-ink-3">
        {t('envFilter.label')}
      </span>
      {items.map((it) => {
        const n = counts?.[it.key];
        return (
          <label key={it.key} className="inline-flex h-8.5 cursor-pointer items-center gap-1.5 text-[13px] whitespace-nowrap text-ink-2 select-none hover:text-ink">
            <input type="checkbox" checked={it.checked} onChange={(e) => it.onChange(e.target.checked)} className="size-4 cursor-pointer accent-[var(--color-accent)]" />
            {it.key === 'none' ? t('common.notSpecified') : t(`env.short.${envKey(it.key)}` as 'env.short.PRD')}
            {n !== undefined && <span className="tabular text-2xs text-ink-3">{n}</span>}
          </label>
        );
      })}
    </fieldset>
  );
}
