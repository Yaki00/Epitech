/**
 * Palette de recherche (Ctrl+K / ⌘K) : pages, applications (filtrées localement) et serveurs
 * (cherchés côté serveur : nom, alias, adresse IP). Entrée ouvre la fiche.
 */
import { useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import { AppWindow, LoaderCircle, Search, Server } from 'lucide-react';
import { api, type ApplicationSummary, type ServerSummary } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { rankByText } from '../lib/search';
import { NAV_ITEMS } from '../app/nav';
import { EnvBadge, Kbd, StatusPill } from './ui';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const APPS_TTL_MS = 5 * 60_000;
const ipOf = (s: ServerSummary): string | null => (typeof s.attrs?.ip === 'string' && s.attrs.ip ? s.attrs.ip : null);

/** Raccourci global : Ctrl+K (Windows) ou ⌘K (Mac). */
export function useCommandPaletteShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<ApplicationSummary[]>([]);
  const appsAt = useRef(0);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // applications : chargées à l'ouverture, gardées 5 minutes
  useEffect(() => {
    if (!open || Date.now() - appsAt.current < APPS_TTL_MS) return undefined;
    const ctrl = new AbortController();
    api
      .applications({ signal: ctrl.signal })
      .then((list) => {
        appsAt.current = Date.now();
        setError(null);
        setApps([...list].sort((a, b) => Number(b.inPerimeter) - Number(a.inPerimeter) || a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : t('palette.error'));
      });
    return () => ctrl.abort();
  }, [open, t]);

  // serveurs : recherche côté serveur (nom, alias, IP), 200 ms après la dernière frappe
  const q = query.trim();
  useEffect(() => {
    if (!open || q.length < 2) {
      setServers([]);
      setSearching(false);
      return undefined;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .servers(q, 8, { signal: ctrl.signal })
        .then((list) => {
          setServers(list);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : t('palette.error'));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setSearching(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, q, t]);

  // fermeture : on repart d'une saisie vide
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const pages = rankByText(NAV_ITEMS, q, (n) => t(n.labelKey), q ? 4 : NAV_ITEMS.length);
  const appMatches = rankByText(apps, q, (a) => a.name, 8);
  const nothing = !pages.length && !appMatches.length && !servers.length && !searching;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t('palette.title')}
      shouldFilter={false}
      loop
      overlayClassName="backdrop-blur-[1px]"
      contentClassName="overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search aria-hidden size={16} className="shrink-0 text-ink-3" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder={t('palette.placeholder')}
          className="h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
        />
        {searching && <LoaderCircle aria-label={t('palette.searching')} size={16} className="shrink-0 animate-spin text-ink-3" />}
      </div>
      <Command.List className="p-1.5">
        {nothing && <div className="px-3 py-6 text-center text-[13px] text-ink-2">{error ?? t('palette.empty')}</div>}

        {pages.length > 0 && (
          <Command.Group heading={t('palette.groupPages')}>
            {pages.map((n) => {
              const Icon = n.icon;
              return (
                <Command.Item key={n.to} value={`page:${n.to}`} onSelect={() => go(n.to)} className={ITEM}>
                  <Icon aria-hidden size={15} strokeWidth={1.75} className="text-ink-3" />
                  <span>{t(n.labelKey)}</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}

        {appMatches.length > 0 && (
          <Command.Group heading={t('palette.groupApps')}>
            {appMatches.map((a) => (
              <Command.Item key={a.id} value={`app:${a.id}`} onSelect={() => go(`/applications/${encodeURIComponent(a.id)}`)} className={ITEM}>
                <AppWindow aria-hidden size={15} strokeWidth={1.75} className="text-ink-3" />
                <span className="truncate font-medium">{a.name}</span>
                {a.criticality && <span className="truncate text-xs text-ink-3">{a.criticality}</span>}
                <StatusPill state={a.status.state} size="sm" className="ml-auto" />
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {servers.length > 0 && (
          <Command.Group heading={t('palette.groupServers')}>
            {servers.map((s) => (
              <Command.Item key={s.id} value={`server:${s.id}`} onSelect={() => go(`/servers/${encodeURIComponent(s.id)}`)} className={ITEM}>
                <Server aria-hidden size={15} strokeWidth={1.75} className="text-ink-3" />
                <span className="truncate font-medium">{s.name}</span>
                {ipOf(s) && <span className="font-mono text-xs text-ink-2">{ipOf(s)}</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <EnvBadge env={s.env} />
                  <StatusPill state={s.state} size="sm" iconOnly />
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {q.length < 2 && <div className="px-3 pt-2 pb-1 text-2xs text-ink-3">{t('palette.typeMore')}</div>}
      </Command.List>
      <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-3 py-1.5 text-2xs text-ink-3">
        <Kbd>↵</Kbd>
        <Kbd>Esc</Kbd>
        <span>{t('palette.hint')}</span>
      </div>
    </Command.Dialog>
  );
}

const ITEM = 'flex h-9 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] text-ink select-none';
