/** Adresses internes des fiches (ids de nœuds `type:clé`, encodés). */
export const appHref = (id: string): string => `/applications/${encodeURIComponent(id)}`;
export const serverHref = (id: string): string => `/servers/${encodeURIComponent(id)}`;
/** Carte limitée à une application (lue par la page Cartographie : `scope=app:<id>`). */
export const appMapHref = (id: string): string => `/map?scope=${encodeURIComponent(`app:${id}`)}`;
