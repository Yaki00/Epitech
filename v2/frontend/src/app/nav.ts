/** Pages de la barre latérale (et de la palette Ctrl+K), dans l'ordre d'affichage. */
import { Activity, AppWindow, Gauge, History, RefreshCw, Server, Waypoints, type LucideIcon } from 'lucide-react';
import type { Key } from '../lib/i18n';

export interface NavItem {
  to: string;
  labelKey: Key;
  icon: LucideIcon;
  /** actif seulement sur le chemin exact */
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: Gauge, end: true },
  { to: '/applications', labelKey: 'nav.applications', icon: AppWindow },
  { to: '/servers', labelKey: 'nav.servers', icon: Server },
  { to: '/map', labelKey: 'nav.map', icon: Waypoints },
  { to: '/monitoring', labelKey: 'nav.monitoring', icon: Activity },
  { to: '/history', labelKey: 'nav.history', icon: History },
  { to: '/sync', labelKey: 'nav.sync', icon: RefreshCw },
];
