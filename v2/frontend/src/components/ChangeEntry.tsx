/**
 * Un changement entre deux imports : résumé en une ligne (accueil) ou détail des éléments (fiche application).
 * Les nœuds connus sont liés à leur fiche ; un lien du graphe s'écrit « A, tourne sur, B ».
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Minus, Pencil, Plus, type LucideIcon } from 'lucide-react';
import type { Change } from '../lib/api';
import { attrValue, changeCounts, nodeLabel, nodeType, parseLinkId } from '../lib/applications';
import { formatDateTime, relativeTime } from '../lib/format';
import { useI18n, type TFunction } from '../lib/i18n';
import { appHref, serverHref } from '../lib/links';
import { edgeLabel, sourceLabel } from '../lib/sources';
import { Badge } from './ui';

/** « 2 ajouts, 1 retrait, 3 modifications » (liens comptés à part). */
export function changeSummary(t: TFunction, c: Pick<Change, 'added' | 'removed' | 'changed'>, sep = ', '): string {
  const n = changeCounts(c);
  const parts: string[] = [];
  if (n.addedNodes) parts.push(t('changes.added', { n: n.addedNodes }));
  if (n.removedNodes) parts.push(t('changes.removed', { n: n.removedNodes }));
  if (n.changed) parts.push(t('changes.changed', { n: n.changed }));
  const links = n.addedLinks + n.removedLinks;
  if (links) parts.push(t('changes.links', { n: links }));
  return parts.join(sep);
}

/** En-tête d'un changement : date, temps écoulé et source. */
export function ChangeHeader({ change }: { change: Change }) {
  const { t, lang } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <time dateTime={change.at} className="text-xs font-medium text-ink">
        {formatDateTime(change.at, lang)}
      </time>
      <span className="text-xs text-ink-3">{relativeTime(change.at, lang)}</span>
      <Badge>{sourceLabel(t, change.source)}</Badge>
    </div>
  );
}

function NodeName({ id, labels }: { id: string; labels: Record<string, string> }) {
  const name = nodeLabel(id, labels);
  const type = nodeType(id);
  if (type === 'server')
    return (
      <Link to={serverHref(id)} className="link font-mono text-xs">
        {name}
      </Link>
    );
  if (type === 'application')
    return (
      <Link to={appHref(id)} className="link">
        {name}
      </Link>
    );
  return <span className="text-ink">{name}</span>;
}

function Item({ id, labels, t }: { id: string; labels: Record<string, string>; t: TFunction }) {
  const link = parseLinkId(id);
  if (!link) return <NodeName id={id} labels={labels} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <NodeName id={link.src} labels={labels} />
      <span className="text-ink-3">{edgeLabel(t, link.type)}</span>
      <NodeName id={link.dst} labels={labels} />
    </span>
  );
}

function Group({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 inline-flex items-center gap-1 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
        <Icon aria-hidden size={12} />
        {title}
      </h4>
      <ul className="flex flex-col gap-1 text-[13px]">{children}</ul>
    </div>
  );
}

/** Détail des éléments ajoutés, retirés et modifiés. */
export function ChangeDetail({ change }: { change: Change }) {
  const { t } = useI18n();
  const labels = change.labels ?? {};
  return (
    <div className="flex flex-col gap-3">
      {change.added.length > 0 && (
        <Group icon={Plus} title={t('changes.addedTitle')}>
          {change.added.map((id) => (
            <li key={id}>
              <Item id={id} labels={labels} t={t} />
            </li>
          ))}
        </Group>
      )}
      {change.removed.length > 0 && (
        <Group icon={Minus} title={t('changes.removedTitle')}>
          {change.removed.map((id) => (
            <li key={id}>
              <Item id={id} labels={labels} t={t} />
            </li>
          ))}
        </Group>
      )}
      {change.changed.length > 0 && (
        <Group icon={Pencil} title={t('changes.changedTitle')}>
          {change.changed.map((c, i) => (
            <li key={`${c.id}-${c.attr}-${i}`} className="flex flex-wrap items-center gap-x-1.5">
              <NodeName id={c.id} labels={labels} />
              <span className="font-mono text-xs text-ink-2">{c.attr}</span>
              <span className="text-ink-3 line-through decoration-ink-3/60">{attrValue(c.before) ?? t('common.none')}</span>
              <ArrowRight aria-hidden size={12} className="text-ink-3" />
              <span className="font-medium text-ink">{attrValue(c.after) ?? t('common.none')}</span>
            </li>
          ))}
        </Group>
      )}
    </div>
  );
}
