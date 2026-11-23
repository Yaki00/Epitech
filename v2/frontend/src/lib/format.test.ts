import { describe, expect, it } from 'vitest';
import { epochSeconds, formatDate, relativeTime, toDate } from './format';
import { rankByText } from './search';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('format', () => {
  it('temps relatif', () => {
    expect(relativeTime(null, 'fr', NOW)).toBe('Jamais');
    expect(relativeTime(ago(10), 'fr', NOW)).toBe('à l’instant');
    expect(relativeTime(ago(5 * 60), 'fr', NOW)).toBe('il y a 5 min');
    expect(relativeTime(ago(3 * 3600), 'en', NOW)).toBe('3 h ago');
    expect(relativeTime(ago(3 * 86400), 'fr', NOW)).toBe('il y a 3 j');
    expect(relativeTime('pas une date', 'en', NOW)).toBe('Never');
  });

  it('epoch en secondes de Naemon', () => {
    expect(epochSeconds(1_700_000_000)?.getTime()).toBe(1_700_000_000_000);
    expect(epochSeconds(null)).toBeNull();
    expect(epochSeconds(0)).toBeNull();
  });

  it('dates illisibles', () => {
    expect(toDate('')).toBeNull();
    expect(formatDate(undefined, 'fr')).toBe('Jamais');
    expect(formatDate('2026-11-18T10:00:00Z', 'fr')).toBe('18/11/2026');
  });
});

describe('rankByText', () => {
  const items = ['Facturation', 'Portail client', 'Référentiel clients', 'Clé'];
  it('ignore casse et accents, début de texte d\'abord', () => {
    expect(rankByText(items, 'cli', (s) => s)).toEqual(['Portail client', 'Référentiel clients']);
    expect(rankByText(items, 'cle', (s) => s)).toEqual(['Clé']);
    expect(rankByText(items, 'refe', (s) => s)).toEqual(['Référentiel clients']);
  });
  it('requête vide : liste tronquée', () => {
    expect(rankByText(items, ' ', (s) => s, 2)).toEqual(['Facturation', 'Portail client']);
  });
});
