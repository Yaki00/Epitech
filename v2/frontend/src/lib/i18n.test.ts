import { describe, expect, it } from 'vitest';
import { DICTIONARIES, LANGS, translate, type Entry } from './i18n';

const SAMPLE_VARS = { n: 2, status: 404, ago: 'x', v: '2.0.0', source: 'Naemon', app: 'Alpha' };
const render = (e: Entry) => (typeof e === 'function' ? e(SAMPLE_VARS) : e);
const placeholders = (e: Entry) => (typeof e === 'function' ? 'fn' : [...e.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(','));

describe('i18n', () => {
  it('fr et en ont exactement les mêmes clés', () => {
    const fr = Object.keys(DICTIONARIES.fr).sort();
    const en = Object.keys(DICTIONARIES.en).sort();
    expect(en.filter((k) => !fr.includes(k))).toEqual([]);
    expect(fr.filter((k) => !en.includes(k))).toEqual([]);
  });

  it('une même clé a la même forme dans les deux langues (texte ou fonction, mêmes variables)', () => {
    for (const key of Object.keys(DICTIONARIES.fr) as (keyof typeof DICTIONARIES.fr)[]) {
      expect(placeholders(DICTIONARIES.en[key]), key).toBe(placeholders(DICTIONARIES.fr[key]));
    }
  });

  it('aucun texte vide, aucun tiret long ni demi-cadratin', () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(DICTIONARIES[lang])) {
        const text = render(entry);
        expect(typeof text, `${lang}:${key}`).toBe('string');
        expect(text.trim().length, `${lang}:${key}`).toBeGreaterThan(0);
        expect(/[\u2013\u2014]/.test(text), `${lang}:${key} contient un tiret long`).toBe(false);
      }
    }
  });

  it('remplace les variables et gère les pluriels', () => {
    expect(translate('fr', 'count.servers', { n: 1 })).toBe('1 serveur');
    expect(translate('fr', 'count.servers', { n: 3 })).toBe('3 serveurs');
    expect(translate('en', 'time.min', { n: 5 })).toBe('5 min ago');
    expect(translate('fr', 'common.httpError', { status: 500 })).toBe('Erreur 500');
  });

  it('clé inconnue : la clé elle-même', () => {
    expect(translate('en', 'nope.missing')).toBe('nope.missing');
  });
});
