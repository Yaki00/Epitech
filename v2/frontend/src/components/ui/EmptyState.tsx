import type { ReactNode } from 'react';
import { CircleAlert, Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../lib/i18n';
import { Button } from './Button';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  /** ce qu'il faut faire pour que la zone se remplisse */
  text?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Zone vide : dit pourquoi et quoi faire. */
export function EmptyState({ icon: Icon = Inbox, title, text, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-12', className)}>
      <Icon aria-hidden size={compact ? 20 : 24} strokeWidth={1.5} className="text-ink-3" />
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {text && <p className="max-w-md text-xs text-ink-2">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Échec de chargement : message du serveur et bouton « Réessayer ». */
export function ErrorState({ error, onRetry, retrying, className }: { error: Error | null; onRetry?: () => void; retrying?: boolean; className?: string }) {
  const { t } = useI18n();
  return (
    <div role="alert" className={cn('flex items-start gap-3 rounded-lg border border-down/30 bg-down-soft px-4 py-3', className)}>
      <CircleAlert aria-hidden size={18} className="mt-px shrink-0 text-down" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">{t('common.loadError')}</p>
        {error?.message && <p className="text-xs break-words text-ink-2">{error.message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
