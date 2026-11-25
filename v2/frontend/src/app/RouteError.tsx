/** Erreur d'affichage d'une page : message lisible au lieu d'un écran blanc. */
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '../components/ui';
import { useI18n } from '../lib/i18n';

export default function RouteError() {
  const { t } = useI18n();
  const err = useRouteError();
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : String(err);
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <EmptyState
        icon={TriangleAlert}
        title={t('error.title')}
        text={
          <>
            {t('error.text')}
            <code className="mt-3 block rounded-md bg-surface-3 px-2 py-1.5 text-left font-mono text-2xs break-words text-ink-2">{message}</code>
          </>
        }
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('error.reload')}
          </Button>
        }
      />
    </div>
  );
}
