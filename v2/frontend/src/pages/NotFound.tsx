import { MapPinOff } from 'lucide-react';
import { Button, Card, EmptyState } from '../components/ui';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';

export default function NotFoundPage() {
  const { t } = useI18n();
  useTitle(t('notFound.title'));
  return (
    <Card className="mt-6">
      <EmptyState
        icon={MapPinOff}
        title={t('notFound.title')}
        text={t('notFound.text')}
        action={
          <Button to="/" variant="primary">
            {t('notFound.back')}
          </Button>
        }
      />
    </Card>
  );
}
