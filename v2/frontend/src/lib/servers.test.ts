import { describe, expect, it } from 'vitest';
import { attrRows, attrText, osLabel } from './servers';

describe('attributs de serveur', () => {
  it('lit texte et nombres, ignore le reste', () => {
    expect(attrText({ a: ' x ', b: 4, c: {}, d: '' }, 'a')).toBe('x');
    expect(attrText({ b: 4 }, 'b')).toBe('4');
    expect(attrText({ c: {} }, 'c')).toBeNull();
    expect(attrText(undefined, 'a')).toBeNull();
  });
  it('assemble le système', () => {
    expect(osLabel({ os: 'Debian', osVersion: '12' })).toBe('Debian 12');
    expect(osLabel({ osVersion: '12' })).toBe('12');
    expect(osLabel({})).toBeNull();
  });
  it('connus d’abord, inconnus listés, masqués et vides exclus', () => {
    const rows = attrRows({ zeta: 'z', ram: '16 Go', ip: '10.0.0.1', retired: true, environment: 'PRD', alpha: { a: 1 }, vide: '' });
    expect(rows.map((r) => r.key)).toEqual(['ip', 'ram', 'alpha', 'zeta']);
    expect(rows[2].label).toBeNull();
    expect(rows[2].value).toBe('{"a":1}');
  });
});
