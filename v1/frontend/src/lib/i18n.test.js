import { afterEach, describe, expect, test } from 'vitest';
import { DICTIONARIES, setCurrentLang, translate } from './i18n';
import { criticalityLabel, edgeLabel, timeAgo, typeLabel } from './format';

afterEach(() => setCurrentLang('fr'));

describe('dictionnaires', () => {
  test('mêmes clés en français et en anglais', () => {
    const fr = Object.keys(DICTIONARIES.fr).sort();
    const en = Object.keys(DICTIONARIES.en).sort();
    expect(fr.filter((k) => !en.includes(k))).toEqual([]);
    expect(en.filter((k) => !fr.includes(k))).toEqual([]);
  });
  test('aucune valeur vide, et les fonctions renvoient du texte', () => {
    for (const dict of Object.values(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        const text = typeof value === 'function' ? value({ n: 2, source: 'X', label: 'Y', when: 'Z', server: 's', app: 'a', pct: 50, ok: 1, total: 2, page: 'p', inventory: 'i', date: 'd' }) : value;
        expect(typeof text, key).toBe('string');
        expect(text.length, key).toBeGreaterThan(0);
      }
    }
  });
  test('pas de tiret long dans les textes', () => {
    for (const dict of Object.values(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) if (typeof value === 'string') expect(value.includes('—'), key).toBe(false);
    }
  });
});

describe('traduction', () => {
  test('pluriels et variables', () => {
    expect(translate('fr', 'apps.servers', { n: 1 })).toBe('1 serveur');
    expect(translate('fr', 'apps.servers', { n: 3 })).toBe('3 serveurs');
    expect(translate('en', 'apps.servers', { n: 3 })).toBe('3 servers');
    expect(translate('en', 'chat.q.depends', { app: 'OrderHub' })).toBe('What does OrderHub depend on?');
  });
  test('clé inconnue : la clé elle-même (repérable)', () => expect(translate('en', 'nexiste.pas')).toBe('nexiste.pas'));
  test('dates relatives et libellés selon la langue courante', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    setCurrentLang('en');
    expect(timeAgo('2026-11-17T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo(null, now)).toBe('Never');
    expect(criticalityLabel('high')).toBe('High');
    expect(typeLabel('server')).toBe('Server');
    expect(edgeLabel('runs_on')).toBe('runs on');
    expect(edgeLabel('type_inconnu')).toBe('type_inconnu');
    setCurrentLang('fr');
    expect(typeLabel('server')).toBe('Serveur');
    expect(edgeLabel('runs_on')).toBe('tourne sur');
  });
});
