/**
 * Traduction de l'interface (français / anglais).
 * - useI18n() dans un composant : { lang, setLang, t } ; le composant se redessine quand la langue change.
 * - t('cle', { n: 3 }) remplace {n} ; une valeur peut aussi être une fonction (pluriels).
 * - Clé inconnue : la clé elle-même est affichée (visible, donc repérable).
 * - La langue choisie est gardée dans le navigateur (localStorage), français par défaut.
 *
 * Ajouter une clé : l'écrire dans `fr` ET dans `en` (le typage et le test de parité l'exigent).
 * Typographie : jamais de tiret long ni de demi-cadratin dans les textes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Vars = Record<string, string | number>;
export type Entry = string | ((vars: Vars) => string);

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);
const num = (v: string | number | undefined) => Number(v ?? 0);

const fr = {
  'app.name': 'Lyra',
  'app.tagline': 'Cartographie et supervision',

  // ponctuation : espace avant les deux-points en français, pas en anglais
  'common.colon': ' :',
  'common.listSep': ' ; ',
  'common.loading': 'Chargement…',
  'common.loadError': 'Impossible de charger les données',
  'common.retry': 'Réessayer',
  'common.close': 'Fermer',
  'common.none': 'Aucun',
  'common.notSpecified': 'Non précisé',
  'common.notConnected': 'Non connecté',
  'common.backendUnreachable': 'Serveur Lyra injoignable (est-il lancé ?)',
  'common.httpError': ({ status }) => `Erreur ${status}`,
  'common.retired': 'Retiré',
  'common.inPerimeter': 'Périmètre',
  'common.outOfPerimeter': 'Hors périmètre',
  'common.comingSoon': 'Cette page arrive bientôt.',
  'common.openInNaemon': 'Ouvrir dans Naemon',
  'common.export': 'Exporter',
  'common.refresh': 'Actualiser',
  'common.back': 'Retour',

  'nav.label': 'Navigation principale',
  'nav.home': 'Accueil',
  'nav.applications': 'Applications',
  'nav.servers': 'Serveurs',
  'nav.map': 'Cartographie',
  'nav.monitoring': 'Supervision',
  'nav.history': 'Historique',
  'nav.sync': 'Synchronisation',
  'nav.openMenu': 'Ouvrir le menu',
  'nav.closeMenu': 'Fermer le menu',

  'header.search': 'Rechercher une application, un serveur, une IP',
  'header.searchShort': 'Rechercher',

  'theme.toLight': 'Passer en thème clair',
  'theme.toDark': 'Passer en thème sombre',
  'lang.switch': 'Langue',
  'lang.toEnglish': 'Switch to English',
  'lang.toFrench': 'Passer en français',

  'demo.banner': 'Données de démonstration',
  'demo.bannerDetail': 'jeu fictif, aucune source réelle n’est interrogée',

  'live.title': 'Supervision',
  'live.off': 'Non branchée',
  'live.pending': 'En attente de la première relève',
  'live.ok': ({ ago }) => `Relevé ${ago}`,
  'live.error': 'Dernière relève en échec',
  'live.errorSince': ({ ago }) => `Dernier succès ${ago}`,
  'live.unreachable': 'Serveur Lyra injoignable',
  'live.version': ({ v }) => `Version ${v}`,

  'palette.title': 'Recherche',
  'palette.placeholder': 'Nom d’application, de serveur ou adresse IP…',
  'palette.empty': 'Aucun résultat',
  'palette.typeMore': 'Saisir au moins 2 caractères pour chercher dans les serveurs',
  'palette.searching': 'Recherche…',
  'palette.groupPages': 'Pages',
  'palette.groupApps': 'Applications',
  'palette.groupServers': 'Serveurs',
  'palette.hint': 'Entrée pour ouvrir, Échap pour fermer',
  'palette.error': 'Recherche impossible',

  'state.ok': 'OK',
  'state.warning': 'Alerte',
  'state.critical': 'Critique',
  'state.down': 'Hors service',
  'state.maintenance': 'Maintenance',
  'state.unknown': 'Inconnu',
  'state.not_monitored': 'Non supervisé',
  'state.degraded': 'Dégradé',
  'state.atRisk': 'À risque',
  'state.ack': 'Pris en charge',

  'env.PRD': 'Production',
  'env.STG': 'Préproduction',
  'env.DEV': 'Développement',
  'env.none': 'Non précisé',
  'env.short.PRD': 'PRD',
  'env.short.STG': 'STG',
  'env.short.DEV': 'DEV',
  'env.short.none': 'N/P',

  'type.application': 'Application',
  'type.server': 'Serveur',
  'type.database': 'Base',
  'type.document': 'Document',
  'type.unknown': 'Inconnu',

  'time.never': 'Jamais',
  'time.now': 'à l’instant',
  'time.inFuture': 'dans un instant',
  'time.min': ({ n }) => `il y a ${n} min`,
  'time.hour': ({ n }) => `il y a ${n} h`,
  'time.day': ({ n }) => `il y a ${n} j`,

  'count.applications': ({ n }) => `${n} ${plural(num(n), 'application', 'applications')}`,
  'count.servers': ({ n }) => `${n} ${plural(num(n), 'serveur', 'serveurs')}`,

  'notFound.title': 'Page introuvable',
  'notFound.text': 'Cette adresse ne correspond à aucune page de Lyra.',
  'notFound.back': 'Retour à l’accueil',
  'error.title': 'Cette page a rencontré une erreur',
  'error.text': 'Recharger la page règle souvent le problème. Si l’erreur revient, noter le message ci-dessous.',
  'error.reload': 'Recharger la page',

  'page.home.title': 'Accueil',
  'page.home.subtitle': 'Santé du périmètre, alertes en cours et fraîcheur des sources',
  'page.applications.title': 'Applications',
  'page.applications.subtitle': 'État, criticité, environnements et score de documentation',
  'page.application.title': 'Fiche application',
  'page.servers.title': 'Serveurs',
  'page.servers.subtitle': 'Inventaire, environnement et état de supervision',
  'page.server.title': 'Fiche serveur',
  'page.map.title': 'Cartographie',
  'page.map.subtitle': 'Applications, serveurs et bases, par environnement',
  'page.monitoring.title': 'Supervision',
  'page.monitoring.subtitle': 'Alertes en cours, impact réel et écarts avec les inventaires',
  'page.history.title': 'Historique',
  'page.history.subtitle': 'Changements d’un import à l’autre',
  'page.sync.title': 'Synchronisation',
  'page.sync.subtitle': 'Imports des inventaires, de la documentation et de la supervision',
} satisfies Record<string, Entry>;

export type Key = keyof typeof fr;

const en: Record<Key, Entry> = {
  'app.name': 'Lyra',
  'app.tagline': 'Mapping and monitoring',

  'common.colon': ':',
  'common.listSep': '; ',
  'common.loading': 'Loading…',
  'common.loadError': 'Could not load the data',
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.none': 'None',
  'common.notSpecified': 'Not specified',
  'common.notConnected': 'Not connected',
  'common.backendUnreachable': 'Lyra server unreachable (is it running?)',
  'common.httpError': ({ status }) => `Error ${status}`,
  'common.retired': 'Retired',
  'common.inPerimeter': 'Scope',
  'common.outOfPerimeter': 'Out of scope',
  'common.comingSoon': 'This page is coming soon.',
  'common.openInNaemon': 'Open in Naemon',
  'common.export': 'Export',
  'common.refresh': 'Refresh',
  'common.back': 'Back',

  'nav.label': 'Main navigation',
  'nav.home': 'Home',
  'nav.applications': 'Applications',
  'nav.servers': 'Servers',
  'nav.map': 'Map',
  'nav.monitoring': 'Monitoring',
  'nav.history': 'History',
  'nav.sync': 'Synchronisation',
  'nav.openMenu': 'Open menu',
  'nav.closeMenu': 'Close menu',

  'header.search': 'Search an application, a server, an IP',
  'header.searchShort': 'Search',

  'theme.toLight': 'Switch to light theme',
  'theme.toDark': 'Switch to dark theme',
  'lang.switch': 'Language',
  'lang.toEnglish': 'Switch to English',
  'lang.toFrench': 'Passer en français',

  'demo.banner': 'Demo data',
  'demo.bannerDetail': 'fictional dataset, no real source is queried',

  'live.title': 'Monitoring',
  'live.off': 'Not connected',
  'live.pending': 'Waiting for the first poll',
  'live.ok': ({ ago }) => `Polled ${ago}`,
  'live.error': 'Last poll failed',
  'live.errorSince': ({ ago }) => `Last success ${ago}`,
  'live.unreachable': 'Lyra server unreachable',
  'live.version': ({ v }) => `Version ${v}`,

  'palette.title': 'Search',
  'palette.placeholder': 'Application name, server name or IP address…',
  'palette.empty': 'No results',
  'palette.typeMore': 'Type at least 2 characters to search servers',
  'palette.searching': 'Searching…',
  'palette.groupPages': 'Pages',
  'palette.groupApps': 'Applications',
  'palette.groupServers': 'Servers',
  'palette.hint': 'Enter to open, Esc to close',
  'palette.error': 'Search failed',

  'state.ok': 'OK',
  'state.warning': 'Warning',
  'state.critical': 'Critical',
  'state.down': 'Down',
  'state.maintenance': 'Maintenance',
  'state.unknown': 'Unknown',
  'state.not_monitored': 'Not monitored',
  'state.degraded': 'Degraded',
  'state.atRisk': 'At risk',
  'state.ack': 'Acknowledged',

  'env.PRD': 'Production',
  'env.STG': 'Staging',
  'env.DEV': 'Development',
  'env.none': 'Not specified',
  'env.short.PRD': 'PRD',
  'env.short.STG': 'STG',
  'env.short.DEV': 'DEV',
  'env.short.none': 'N/S',

  'type.application': 'Application',
  'type.server': 'Server',
  'type.database': 'Database',
  'type.document': 'Document',
  'type.unknown': 'Unknown',

  'time.never': 'Never',
  'time.now': 'just now',
  'time.inFuture': 'in a moment',
  'time.min': ({ n }) => `${n} min ago`,
  'time.hour': ({ n }) => `${n} h ago`,
  'time.day': ({ n }) => `${n} d ago`,

  'count.applications': ({ n }) => `${n} ${plural(num(n), 'application', 'applications')}`,
  'count.servers': ({ n }) => `${n} ${plural(num(n), 'server', 'servers')}`,

  'notFound.title': 'Page not found',
  'notFound.text': 'This address does not match any Lyra page.',
  'notFound.back': 'Back to home',
  'error.title': 'This page ran into an error',
  'error.text': 'Reloading the page often fixes it. If the error comes back, note the message below.',
  'error.reload': 'Reload the page',

  'page.home.title': 'Home',
  'page.home.subtitle': 'Scope health, current alerts and source freshness',
  'page.applications.title': 'Applications',
  'page.applications.subtitle': 'State, criticality, environments and documentation score',
  'page.application.title': 'Application',
  'page.servers.title': 'Servers',
  'page.servers.subtitle': 'Inventory, environment and monitoring state',
  'page.server.title': 'Server',
  'page.map.title': 'Map',
  'page.map.subtitle': 'Applications, servers and databases, by environment',
  'page.monitoring.title': 'Monitoring',
  'page.monitoring.subtitle': 'Current alerts, real impact and inventory gaps',
  'page.history.title': 'History',
  'page.history.subtitle': 'Changes from one import to the next',
  'page.sync.title': 'Synchronisation',
  'page.sync.subtitle': 'Inventory, documentation and monitoring imports',
};

export const DICTIONARIES: Record<Lang, Record<Key, Entry>> = { fr, en };
export const LANGS = ['fr', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_STORAGE_KEY = 'lyra.lang';

const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

function initialLang(): Lang {
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* stockage indisponible : langue par défaut */
  }
  return 'fr';
}

let current: Lang = typeof window === 'undefined' ? 'fr' : initialLang();

/** Langue courante, pour le code hors composant (formatage, messages d'erreur de l'API). */
export const getLang = (): Lang => current;
/** Change la langue courante sans passer par React (tests). */
export const setCurrentLang = (lang: string) => {
  current = isLang(lang) ? lang : 'fr';
};

/** Traduit une clé dans une langue donnée. */
export function translate(lang: Lang, key: Key | string, vars: Vars = {}): string {
  const value = (DICTIONARIES[lang] as Record<string, Entry>)[key] ?? (DICTIONARIES.fr as Record<string, Entry>)[key];
  if (value === undefined) return key;
  if (typeof value === 'function') return value(vars);
  return value.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** Traduction dans la langue courante (hors composant). */
export const t = (key: Key, vars?: Vars) => translate(current, key, vars);

export type TFunction = (key: Key, vars?: Vars) => string;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({ lang: 'fr', setLang: () => {}, t: (k, v) => translate('fr', k, v) });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  const setLang = useCallback((next: Lang) => {
    setCurrentLang(next);
    setLangState(current);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, current);
    } catch {
      /* stockage indisponible : la langue tient jusqu'au rechargement */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<I18nValue>(() => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
