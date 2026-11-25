import { cn } from '../../lib/cn';

/** Ton d'un score de documentation (0 à 100). */
export const scoreTone = (score: number): 'ok' | 'warn' | 'down' => (score >= 70 ? 'ok' : score >= 40 ? 'warn' : 'down');

const BAR = { ok: 'bg-ok', warn: 'bg-warn', down: 'bg-down' } as const;

/** Score sur 100 : nombre + barre (le nombre reste lisible sans la couleur). */
export function ScoreMeter({ score, label, className }: { score: number; label?: string; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <span className={cn('inline-flex items-center gap-2', className)} title={label}>
      <span className="tabular w-7 text-right text-xs font-medium text-ink">{v}</span>
      <span
        role="meter"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
      >
        <span className={cn('block h-full rounded-full', BAR[scoreTone(v)])} style={{ width: `${v}%` }} />
      </span>
    </span>
  );
}
