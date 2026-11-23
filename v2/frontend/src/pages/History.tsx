/**
 * Historique : changements d'un import à l'autre (date, source, ajouts, retraits, modifications),
 * filtrables par source ; chaque import se déplie pour voir le détail (noms tirés de `Change.labels`).
 * Données : /api/changes (200 derniers imports au plus).
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronRight, History as HistoryIcon, RefreshCw } from 'lucide-react';
import { api, useApi, type Change } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { changeCounts } from '../lib/applications';
import { formatDateTime, relativeTime } from '../lib/format';
import { sourceLabel } from '../lib/sources';
import { cn } from '../lib/cn';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonRows } from '../components/ui';
import { SelectField } from '../components/filters';
import { ChangeDetail } from '../components/ChangeEntry';

/** Imports demandés (maximum de l'API). */
const CHANGES_LIMIT = 200;

const keyOf = (c: Change, i: number) => `${c.at}|${c.source}|${i}`;

export default function HistoryPage() {
  const { t } = useI18n();
  useTitle(t('page.history.title'));
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.changes(CHANGES_LIMIT, { signal }), []);
  const [params, setParams] = useSearchParams();
  const source = params.get('source') ?? 'all';
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const entries = useMemo(() => (data ?? []).map((c, i) => ({ c, key: keyOf(c, i) })), [data]);
  const sources = useMemo(() => [...new Set((data ?? []).map((c) => c.source))].sort(), [data]);
  const rows = source === 'all' ? entries : entries.filter((e) => e.c.source === source);
  const setSource = (v: string) => {
    const p = new URLSearchParams(params);
    if (v === 'all') p.delete('source');
    else p.set('source', v);
    setParams(p, { replace: true });
  };
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allOpen = rows.length > 0 && rows.every((r) => open.has(r.key));
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.key)));

  return (
    <>
      <PageHeader
        title={t('page.history.title')}
        subtitle={t('page.history.subtitle')}
        meta={data && <Badge>{t('history.count', { n: rows.length })}</Badge>}
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reload} disabled={loading || refreshing} className={refreshing ? '[&>svg]:animate-spin' : undefined}>
            {t('common.refresh')}
          </Button>
        }
      />
      {error && data && <ErrorState error={error} onRetry={reload} retrying={refreshing} className="mb-4" />}
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line p-3">
          <SelectField
            label={t('history.filter.source')}
            value={sources.includes(source) ? source : 'all'}
            onChange={setSource}
            options={[{ value: 'all', label: t('history.filter.allSources') }, ...sources.map((s) => ({ value: s, label: sourceLabel(t, s) }))]}
            className="w-full sm:w-56"
          />
          {rows.length > 0 && (
            <Button size="sm" variant="ghost" onClick={toggleAll} className="sm:ml-auto">
              {allOpen ? t('history.collapseAll') : t('history.expandAll')}
            </Button>
          )}
        </div>
        {loading ? (
          <SkeletonRows rows={8} />
        ) : !data ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={reload} retrying={refreshing} />
          </div>
        ) : data.length === 0 ? (
          <EmptyState icon={HistoryIcon} title={t('changes.empty')} text={t('changes.emptyText')} />
        ) : rows.length === 0 ? (
          <EmptyState compact icon={HistoryIcon} title={t('history.emptyFiltered')} action={<Button size="sm" onClick={() => setSource('all')}>{t('history.filter.allSources')}</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map(({ c, key }) => (
              <HistoryItem key={key} change={c} id={key} open={open.has(key)} onToggle={() => toggle(key)} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone: 'ok' | 'down' | 'neutral' }) {
  return (
    <span className={cn('inline-flex items-baseline gap-1 text-xs', n === 0 ? 'text-ink-3' : 'text-ink-2')}>
      <span className={cn('tabular font-semibold', n > 0 && tone === 'ok' && 'text-ok', n > 0 && tone === 'down' && 'text-down', n > 0 && tone === 'neutral' && 'text-ink')}>{n}</span>
      {label}
    </span>
  );
}

function HistoryItem({ change, id, open, onToggle }: { change: Change; id: string; open: boolean; onToggle: () => void }) {
  const { t, lang } = useI18n();
  const n = changeCounts(change);
  const links = n.addedLinks + n.removedLinks;
  const empty = change.added.length + change.removed.length + change.changed.length === 0;
  const panelId = `history-${id.replace(/[^\w-]/g, '_')}`;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        disabled={empty}
        aria-expanded={empty ? undefined : open}
        aria-controls={empty ? undefined : panelId}
        className="flex w-full flex-col gap-1.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent sm:flex-row sm:items-center sm:gap-4"
      >
        <span className="flex min-w-0 items-center gap-2 sm:w-80 sm:shrink-0">
          <ChevronRight aria-hidden size={15} className={cn('shrink-0 text-ink-3 transition-transform', open && 'rotate-90', empty && 'invisible')} />
          {/* en-tête en éléments en ligne : il est dans un bouton */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <time dateTime={change.at} className="text-xs font-medium text-ink">
              {formatDateTime(change.at, lang)}
            </time>
            <span className="text-xs text-ink-3">{relativeTime(change.at, lang)}</span>
            <Badge>{sourceLabel(t, change.source)}</Badge>
          </span>
        </span>
        <span className="flex flex-wrap gap-x-4 gap-y-0.5 pl-6 sm:pl-0">
          <Count n={n.addedNodes} label={t('history.added', { n: n.addedNodes })} tone="ok" />
          <Count n={n.removedNodes} label={t('history.removed', { n: n.removedNodes })} tone="down" />
          <Count n={n.changed} label={t('history.changed', { n: n.changed })} tone="neutral" />
          {links > 0 && <Count n={links} label={t('history.links', { n: links })} tone="neutral" />}
          {empty && <span className="text-xs text-ink-3">{t('history.noChange')}</span>}
        </span>
      </button>
      {open && !empty && (
        <div id={panelId} className="border-t border-line bg-surface-2/50 px-4 py-3 sm:pl-10">
          <ChangeDetail change={change} />
        </div>
      )}
    </li>
  );
}
