import { cn } from '../../lib/cn';
import { useI18n } from '../../lib/i18n';

/** Bloc de chargement ; la taille vient de `className` (ex. "h-4 w-32"). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-sm', className)} />;
}

/** Lignes de chargement (tableaux, listes), annoncées une fois aux lecteurs d'écran. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className={cn('flex flex-col gap-2.5 p-4', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className={cn('h-3.5', i % 3 === 0 ? 'w-2/5' : i % 3 === 1 ? 'w-1/3' : 'w-1/2')} />
          <Skeleton className="ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}
