import { describe, expect, it } from 'vitest';
import { csvCell, simulationCsv, toCsv } from './exportCsv';
import { translate } from '../lib/i18n';
import type { Key } from '../lib/i18n';

describe('exportCsv', () => {
  it('échappe le séparateur, les guillemets et les retours à la ligne', () => {
    expect(csvCell('simple')).toBe('simple');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('ligne1\nligne2')).toBe('"ligne1\nligne2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('neutralise les formules Excel', () => {
    expect(csvCell('=SOMME(A1)')).toBe("'=SOMME(A1)");
    expect(csvCell('+33')).toBe("'+33");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('BOM, « ; » et CRLF', () => {
    expect(toCsv([['a', 'b'], ['c;d', 'e']])).toBe('﻿a;b\r\n"c;d";e\r\n');
  });

  it('origines puis éléments touchés, avec niveau et lien', () => {
    const t = (k: Key, v?: Record<string, string | number>) => translate('fr', k, v);
    const csv = simulationCsv(
      [{ id: 'server:s1', name: 'srv-1', type: 'server' }],
      {
        impacted: [{ id: 'application:a', name: 'Appli; A', type: 'application', depth: 1, via: { edgeType: 'runs_on', from: 'server:s1', source: 'apm', confidence: 1 } }],
        byType: { application: ['application:a'] },
        unknown: [],
      },
      t,
      (id) => (id === 'server:s1' ? 'srv-1' : id),
    );
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Origine;Serveur;srv-1;server:s1;0;;;;');
    expect(lines[2]).toBe('Touché;Application;"Appli; A";application:a;1;srv-1;Hébergement;apm;100');
  });
});
