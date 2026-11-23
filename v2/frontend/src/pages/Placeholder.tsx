/** Page provisoire (remplacée par les vraies pages). */
import { Construction } from 'lucide-react';
import { Card, EmptyState, PageHeader } from '../components/ui';
import { useI18n, type Key } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';

export function Placeholder({ titleKey, subtitleKey, back, detail }: { titleKey: Key; subtitleKey?: Key; back?: { to: string; labelKey: Key }; detail?: string }) {
  const { t } = useI18n();
  useTitle(t(titleKey));
  return (
    <>
      <PageHeader title={detail ?? t(titleKey)} subtitle={subtitleKey ? t(subtitleKey) : undefined} back={back && { to: back.to, label: t(back.labelKey) }} />
      <Card>
        <EmptyState icon={Construction} title={t('common.comingSoon')} />
      </Card>
    </>
  );
}
