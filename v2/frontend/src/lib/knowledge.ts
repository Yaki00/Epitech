/**
 * Logique pure de la documentation opérationnelle (fiches) : sources des réponses du chat, bloc de l'onglet
 * Documentation d'une application. Regroupement par genre, tri du plus récent au plus ancien, étiquettes.
 */
import type { BadgeTone } from '../components/ui/Badge';
import type { Key } from './i18n';
import { toDate } from './format';

/** Genres de fiches, dans l'ordre d'affichage du bloc. */
export const FICHE_KINDS = ['procedure', 'incident', 'correctif', 'pratique'] as const;
export type FicheKind = (typeof FICHE_KINDS)[number];

const isFicheKind = (k: string): k is FicheKind => (FICHE_KINDS as readonly string[]).includes(k);

/** Clé de libellé du genre ; tout genre inconnu (dont « page », section de page) est une page. */
export const kindKey = (kind: string): Key => `knowledge.kind.${isFicheKind(kind) ? kind : 'page'}` as Key;

/** Clé du titre de groupe (pluriel) d'un genre de fiche. */
export const groupKey = (kind: FicheKind): Key => `knowledge.group.${kind}` as Key;

export interface Flags {
  old?: boolean;
  replaced?: boolean;
  otherApplication?: boolean;
}

/** Source citée par une réponse du chat (POST /api/ask). */
export interface SourceItem extends Flags {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  appNames: string[];
  /** pas fournie par le serveur pour l'instant : affichée si elle existe */
  updatedAt?: string | null;
}

/** Fiche listée sur la page d'une application (GET /api/applications/:id, champ `knowledge`). */
export interface KnowledgeItem {
  id: string;
  kind: string;
  title: string;
  period: string | null;
  updatedAt: string | null;
  url: string | null;
  old: boolean;
  replaced: boolean;
}

/** Adresse affichable en lien : http ou https seulement (jamais javascript:, data:, relative...). */
export function safeUrl(u: string | null | undefined): string | null {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const p = new URL(u.trim()).protocol;
    return p === 'http:' || p === 'https:' ? u.trim() : null;
  } catch {
    return null;
  }
}

/** Date lisible telle quelle, ou null (absente ou illisible : rien n'est affiché). */
export const validDate = (v: string | null | undefined): string | null => (v && toDate(v) ? v : null);

export interface SourceBadge {
  key: Key;
  tone: BadgeTone;
}

/** Étiquettes d'une fiche : ancienne, remplacée, autre application (dans cet ordre). */
export function sourceBadges(f: Flags): SourceBadge[] {
  const out: SourceBadge[] = [];
  if (f.old) out.push({ key: 'knowledge.badge.old', tone: 'warn' });
  if (f.replaced) out.push({ key: 'knowledge.badge.replaced', tone: 'warn' });
  if (f.otherApplication) out.push({ key: 'knowledge.badge.otherApp', tone: 'unmon' });
  return out;
}

export interface SourceView {
  kindKey: Key;
  title: string;
  apps: string[];
  date: string | null;
  url: string | null;
}

/** Ce que la carte de source affiche. */
export function sourceView(s: SourceItem): SourceView {
  return {
    kindKey: kindKey(s.kind),
    title: s.title,
    apps: Array.isArray(s.appNames) ? s.appNames : [],
    date: validDate(s.updatedAt),
    url: safeUrl(s.url),
  };
}

export interface KnowledgeGroup {
  kind: FicheKind;
  items: KnowledgeItem[];
}

const time = (v: string | null) => toDate(v)?.getTime() ?? Number.NEGATIVE_INFINITY;

/** Fiches regroupées par genre (groupes vides omis), la plus récente d'abord, sans date en dernier. */
export function groupKnowledge(items: readonly KnowledgeItem[] | null | undefined): KnowledgeGroup[] {
  const list = Array.isArray(items) ? items : [];
  return FICHE_KINDS.map((kind) => ({
    kind,
    items: list.filter((i) => i.kind === kind).sort((a, b) => time(b.updatedAt) - time(a.updatedAt)),
  })).filter((g) => g.items.length > 0);
}
