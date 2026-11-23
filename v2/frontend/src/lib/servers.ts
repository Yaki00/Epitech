/** Aides pour les serveurs : lecture des attributs libres et libellés de ceux qu'on connaît. */
import type { Attrs } from './api';
import type { Key } from './i18n';

/** Valeur texte ou numérique d'un attribut, sinon null. */
export function attrText(attrs: Attrs | null | undefined, key: string): string | null {
  const v = attrs?.[key];
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** « Red Hat Enterprise Linux 8.9 » */
export const osLabel = (attrs: Attrs | null | undefined): string | null => [attrText(attrs, 'os'), attrText(attrs, 'osVersion')].filter(Boolean).join(' ') || null;

/** Attributs connus, dans l'ordre d'affichage, avec la clé de traduction de leur libellé. */
export const KNOWN_ATTRS: { key: string; label: Key }[] = [
  { key: 'fqdn', label: 'server.attr.fqdn' },
  { key: 'osHost', label: 'server.attr.osHost' },
  { key: 'ip', label: 'server.attr.ip' },
  { key: 'os', label: 'server.attr.os' },
  { key: 'osVersion', label: 'server.attr.osVersion' },
  { key: 'cpu', label: 'server.attr.cpu' },
  { key: 'cpuCores', label: 'server.attr.cpuCores' },
  { key: 'ram', label: 'server.attr.ram' },
  { key: 'country', label: 'server.attr.country' },
  { key: 'provisioner', label: 'server.attr.provisioner' },
];

/** Attributs déjà montrés ailleurs dans la fiche (environnement, retrait, hors inventaire, lecture IA) : exclus de la liste générique. */
const HIDDEN_ATTRS = new Set(['environment', 'retired', 'type', 'name', 'apm_row', 'outOfInventory', 'fromLlm']);

export interface AttrRow {
  key: string;
  /** clé de traduction si l'attribut est connu */
  label: Key | null;
  value: string;
}

/** Lignes à afficher : connus d'abord, puis les autres par ordre alphabétique (valeurs vides ignorées). */
export function attrRows(attrs: Attrs | null | undefined): AttrRow[] {
  if (!attrs) return [];
  const text = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const known = new Set(KNOWN_ATTRS.map((k) => k.key));
  const rows: AttrRow[] = [];
  for (const k of KNOWN_ATTRS) {
    const v = text(attrs[k.key]);
    if (v !== null) rows.push({ key: k.key, label: k.label, value: v });
  }
  for (const key of Object.keys(attrs).sort()) {
    if (known.has(key) || HIDDEN_ATTRS.has(key)) continue;
    const v = text(attrs[key]);
    if (v !== null) rows.push({ key, label: null, value: v });
  }
  return rows;
}
