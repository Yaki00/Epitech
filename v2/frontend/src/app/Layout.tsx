/**
 * Cadre de toutes les pages : barre latérale (navigation, état de la supervision), en-tête
 * (recherche Ctrl+K, langue, thème), bandeau « Données de démonstration » en mode démo.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { FlaskConical, Menu, Moon, Search, Sun, X } from 'lucide-react';
import { useI18n, type Lang } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useConfig } from '../lib/config';
import { useLiveStatus } from '../lib/live';
import { relativeTime } from '../lib/format';
import { cn } from '../lib/cn';
import { CommandPalette, useCommandPaletteShortcut } from '../components/CommandPalette';
import { Kbd, SkeletonRows } from '../components/ui';
import { NAV_ITEMS } from './nav';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export default function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  useCommandPaletteShortcut(togglePalette);
  const location = useLocation();

  // le menu mobile se referme à chaque changement de page
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="min-h-dvh lg:pl-56">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-h-dvh min-w-0 flex-col">
        <DemoBanner />
        <Header onSearch={() => setPaletteOpen(true)} onMenu={() => setMenuOpen(true)} />
        <main id="contenu" className="mx-auto w-full max-w-[1480px] min-w-0 flex-1 px-4 py-5 md:px-6 lg:px-8 lg:py-6">
          <Suspense fallback={<SkeletonRows rows={8} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ScrollRestoration />
    </div>
  );
}

function Brand() {
  const { t } = useI18n();
  return (
    <div className="flex h-13 items-center gap-2.5 px-4">
      <svg aria-hidden viewBox="0 0 32 32" className="size-6 shrink-0">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="text-sidebar-ink">
          <path d="M10 8l6 3.5 5 11-9 1.5z" />
        </g>
        <g className="fill-sidebar-ink-strong">
          <circle cx="10" cy="8" r="2.6" />
          <circle cx="16" cy="11.5" r="1.6" />
          <circle cx="21" cy="22.5" r="1.6" />
          <circle cx="12" cy="24" r="1.6" />
        </g>
      </svg>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight text-sidebar-ink-strong">{t('app.name')}</div>
        <div className="text-2xs text-sidebar-ink">{t('app.tagline')}</div>
      </div>
    </div>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <>
      {open && <div aria-hidden className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-sidebar-line bg-sidebar text-sidebar-ink transition-transform lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between">
          <Brand />
          <button type="button" onClick={onClose} aria-label={t('nav.closeMenu')} className="mr-2 rounded-md p-1.5 text-sidebar-ink hover:text-sidebar-ink-strong lg:hidden">
            <X aria-hidden size={18} />
          </button>
        </div>
        <nav aria-label={t('nav.label')} className="flex-1 overflow-y-auto px-2 py-2">
          <ul className="flex flex-col gap-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'relative flex h-8.5 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
                        isActive
                          ? 'bg-sidebar-active font-medium text-sidebar-ink-strong before:absolute before:inset-y-2 before:-left-2 before:w-0.5 before:rounded-full before:bg-sidebar-ink-strong'
                          : 'hover:bg-sidebar-active/60 hover:text-sidebar-ink-strong',
                      )
                    }
                  >
                    <Icon aria-hidden size={16} strokeWidth={1.75} />
                    {t(item.labelKey)}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
        <LiveIndicator />
      </aside>
    </>
  );
}

/** Pied de la barre latérale : fraîcheur de la relève Naemon (relue toutes les minutes). */
function LiveIndicator() {
  const { t, lang } = useI18n();
  const { status, error } = useLiveStatus();
  const { config } = useConfig();

  let dot = 'bg-unknown';
  let line = t('common.loading');
  let sub: string | null = null;
  let title: string | undefined;
  if (!status && error) {
    dot = 'bg-down';
    line = t('live.unreachable');
  } else if (status) {
    if (status.source === 'off') {
      dot = 'bg-unknown';
      line = t('live.off');
    } else if (status.lastError) {
      dot = 'bg-down';
      line = t('live.error');
      title = status.lastError;
      sub = status.lastOk ? t('live.errorSince', { ago: relativeTime(status.lastOk, lang) }) : null;
    } else if (!status.lastOk) {
      dot = 'bg-warn';
      line = t('live.pending');
    } else {
      dot = 'bg-ok';
      line = t('live.ok', { ago: relativeTime(status.lastOk, lang) });
    }
  }

  return (
    <div className="border-t border-sidebar-line px-4 py-3 text-2xs" title={title}>
      <div className="font-medium text-sidebar-ink-strong">{t('live.title')}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} />
        <span aria-live="polite">{line}</span>
      </div>
      {sub && <div className="mt-0.5 pl-3">{sub}</div>}
      {config?.version && <div className="mt-2 opacity-70">{t('live.version', { v: config.version })}</div>}
    </div>
  );
}

function DemoBanner() {
  const { t } = useI18n();
  const { config } = useConfig();
  if (!config?.demo) return null;
  return (
    <div role="note" className="flex min-h-7 items-center justify-center gap-1.5 border-b border-line bg-surface-3 px-4 py-1 text-center text-xs text-ink-2">
      <FlaskConical aria-hidden size={13} className="shrink-0" />
      <span>
        <span className="font-medium text-ink">{t('demo.banner')}</span>
        {t('common.colon')} {t('demo.bannerDetail')}
      </span>
    </div>
  );
}

function Header({ onSearch, onMenu }: { onSearch: () => void; onMenu: () => void }) {
  const { t, lang, setLang } = useI18n();
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-20 flex h-13 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur-sm md:px-6 lg:px-8">
      <button type="button" onClick={onMenu} aria-label={t('nav.openMenu')} className="rounded-md p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink lg:hidden">
        <Menu aria-hidden size={18} />
      </button>
      <button
        type="button"
        onClick={onSearch}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        className="flex h-8.5 w-full max-w-md min-w-0 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-left text-[13px] text-ink-3 transition-colors hover:border-line-strong"
      >
        <Search aria-hidden size={15} className="shrink-0" />
        <span className="hidden truncate sm:inline">{t('header.search')}</span>
        <span className="truncate sm:hidden">{t('header.searchShort')}</span>
        <span className="ml-auto hidden shrink-0 items-center gap-0.5 sm:flex">
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ml-auto flex items-center gap-1">
        <LangSwitch lang={lang} setLang={setLang} />
        <button
          type="button"
          onClick={toggle}
          aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          className="rounded-md p-2 text-ink-2 hover:bg-surface-3 hover:text-ink"
        >
          {theme === 'dark' ? <Sun aria-hidden size={16} /> : <Moon aria-hidden size={16} />}
        </button>
      </div>
    </header>
  );
}

function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const { t } = useI18n();
  const options: { value: Lang; label: string; title: string }[] = [
    { value: 'fr', label: 'FR', title: t('lang.toFrench') },
    { value: 'en', label: 'EN', title: t('lang.toEnglish') },
  ];
  return (
    <div role="group" aria-label={t('lang.switch')} className="flex h-7 items-center rounded-md border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          aria-pressed={lang === o.value}
          title={o.title}
          onClick={() => setLang(o.value)}
          className={cn('h-full rounded-sm px-1.5 text-2xs font-semibold', lang === o.value ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
