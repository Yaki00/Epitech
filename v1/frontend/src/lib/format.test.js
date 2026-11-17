import { describe, expect, test } from 'vitest';
import { initials, normalizeCriticality, timeAgo } from './format';

describe('normalizeCriticality', () => {
  test.each([
    ['Critique', 'critical'],
    ['CRITICAL', 'critical'],
    ['P1', 'critical'],
    ['Haute', 'high'],
    ['Élevée', 'high'],
    ['High', 'high'],
    ['Medium', 'medium'],
    ['Moyenne', 'medium'],
    ['3', 'medium'],
    ['Faible', 'low'],
    ['Low', 'low'],
    ['', 'unknown'],
    [null, 'unknown'],
    ['???', 'unknown'],
  ])('%s -> %s', (input, expected) => expect(normalizeCriticality(input)).toBe(expected));
});

describe('initials', () => {
  test('un mot', () => expect(initials('ALTO')).toBe('AL'));
  test('deux mots', () => expect(initials('Calypso Equity')).toBe('CE'));
  test('vide', () => expect(initials('')).toBe('?'));
});

describe('timeAgo', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  test('jamais', () => expect(timeAgo(null, now)).toBe('Jamais'));
  test('date SQLite UTC sans fuseau', () => expect(timeAgo('2026-11-17 10:00:00', now)).toBe('il y a 2 h'));
  test('minutes', () => expect(timeAgo('2026-11-17T11:55:00Z', now)).toBe('il y a 5 min'));
});
