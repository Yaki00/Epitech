/** Recherche locale tolérante : casse et accents ignorés. */
export const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/**
 * Filtre et classe des éléments par leur texte : début de mot d'abord, puis contenu.
 * Requête vide : la liste telle quelle (tronquée à `limit`).
 */
export function rankByText<T>(items: readonly T[], query: string, text: (item: T) => string, limit = 8): T[] {
  const q = normalize(query);
  if (!q) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = normalize(text(item));
    const i = s.indexOf(q);
    if (i < 0) continue;
    const wordStart = i === 0 || /[^a-z0-9]/.test(s[i - 1] ?? '');
    scored.push({ item, score: (i === 0 ? 0 : wordStart ? 1 : 2) * 1000 + s.length });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.item);
}
