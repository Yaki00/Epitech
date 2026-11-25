/**
 * Configuration de l'interface (/api/config), lue une fois au démarrage.
 * `demo` affiche le bandeau « Données de démonstration » ; `naemonUrlTemplate` sert aux liens Naemon.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type UiConfig } from './api';

interface ConfigValue {
  /** null tant que la configuration n'est pas lue (ou si le serveur est injoignable) */
  config: UiConfig | null;
  error: Error | null;
}

const ConfigContext = createContext<ConfigValue>({ config: null, error: null });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<ConfigValue>({ config: null, error: null });
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .config({ signal: ctrl.signal })
      .then((config) => setValue({ config, error: null }))
      .catch((error: unknown) => {
        if (!ctrl.signal.aborted) setValue({ config: null, error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => ctrl.abort();
  }, []);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export const useConfig = () => useContext(ConfigContext);

/** Lien Naemon d'une application ({app} remplacé par son nom), ou null si non configuré. */
export function naemonLink(template: string | null | undefined, appName: string): string | null {
  if (!template) return null;
  return template.split('{app}').join(encodeURIComponent(appName));
}
