/**
 * États de supervision « en direct » : /api/status relu toutes les minutes, partagé par toute l'interface
 * (pied de la barre latérale, pages qui veulent superposer les états sans recharger leurs propres données).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { api, REFRESH_MS, useApi, type LiveStatus } from './api';

interface LiveValue {
  status: LiveStatus | null;
  error: Error | null;
  reload: () => void;
}

const LiveContext = createContext<LiveValue>({ status: null, error: null, reload: () => {} });

export function LiveStatusProvider({ children }: { children: ReactNode }) {
  const { data, error, reload } = useApi((signal) => api.status({ signal }), [], { refreshMs: REFRESH_MS });
  return <LiveContext.Provider value={{ status: data, error, reload }}>{children}</LiveContext.Provider>;
}

export const useLiveStatus = () => useContext(LiveContext);
