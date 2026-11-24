import { useI18n, type Key } from '../lib/i18n';
import { sourceBadges, type Flags } from '../lib/knowledge';
import { Badge } from './ui';

/** Étiquettes « ancienne », « remplacée », « autre application » d'une fiche ou d'une source. */
export function KnowledgeBadges({ flags }: { flags: Flags }) {
  const { t } = useI18n();
  return (
    <>
      {sourceBadges(flags).map((b) => (
        <Badge key={b.key} tone={b.tone} title={t(`${b.key}.hint` as Key)}>
          {t(b.key)}
        </Badge>
      ))}
    </>
  );
}
