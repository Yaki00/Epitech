import { useEffect } from 'react';

/** Titre de l'onglet du navigateur : « <titre> | Lyra ». */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} | Lyra` : 'Lyra';
  }, [title]);
}
