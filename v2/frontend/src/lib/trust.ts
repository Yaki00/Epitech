/**
 * Marques de confiance et de période d'un lien (fiche application, carte) : un lien inactif est grisé,
 * masqué par défaut, et porte une étiquette qui dit pourquoi.
 */
import type { BadgeTone } from '../components/ui/Badge';
import type { Key } from './i18n';

/** Pourquoi un lien est inactif : à valider, autre application, ancien, cible, ou retiré. */
export type LinkMark = 'toValidate' | 'otherApp' | 'past' | 'target' | 'retired';

export interface LinkMarkInput {
  retired: boolean;
  /** carte : lien inactif */
  inactive?: boolean;
  /** fiche application : au moins un lien actif vers le nœud */
  active?: boolean;
  trust?: string | null;
  period?: string | null;
}

/**
 * Marque d'un lien, null s'il est actif. La période et la confiance l'emportent sur « retiré » :
 * dans la fiche, `retired` vaut aussi pour un lien inactif dont le nœud est bien présent.
 */
export function linkMark(x: LinkMarkInput): LinkMark | null {
  const inactive = x.inactive === true || x.active === false;
  if (!x.retired && !inactive) return null;
  if (x.trust === 'toValidate') return 'toValidate';
  if (x.period === 'past') return 'past';
  if (x.period === 'target') return 'target';
  if (x.trust === 'otherApp') return 'otherApp';
  return 'retired';
}

export interface LinkMarkMeta {
  labelKey: Key;
  /** infobulle : ce que la marque veut dire */
  hintKey: Key;
  tone: BadgeTone;
}

export const LINK_MARK_META: Record<LinkMark, LinkMarkMeta> = {
  toValidate: { labelKey: 'trust.toValidate', hintKey: 'trust.toValidate.hint', tone: 'warn' },
  otherApp: { labelKey: 'trust.otherApp', hintKey: 'trust.otherApp.hint', tone: 'warn' },
  past: { labelKey: 'trust.past', hintKey: 'trust.past.hint', tone: 'neutral' },
  target: { labelKey: 'trust.target', hintKey: 'trust.target.hint', tone: 'neutral' },
  retired: { labelKey: 'common.retired', hintKey: 'trust.retired.hint', tone: 'neutral' },
};

/** Période d'une page de documentation : badge pour « ancienne » et « cible », rien pour l'actuelle. */
export function pagePeriodKey(period: string | null | undefined): Key | null {
  if (period === 'past') return 'appDetail.docs.period.past';
  if (period === 'target') return 'appDetail.docs.period.target';
  return null;
}
