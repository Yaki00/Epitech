import { describe, expect, it } from 'vitest';
import { historyOf, linkifyParts, parseAnswer, splitAnswer, traceEntities, traceTools } from './chat';

describe('chat', () => {
  it('réponse simulée du mode démo', () => {
    expect(parseAnswer('[démo] Si Atlas tombe...')).toEqual({ demo: true, text: 'Si Atlas tombe...' });
    expect(parseAnswer('Réponse normale')).toEqual({ demo: false, text: 'Réponse normale' });
  });

  it('adresses web dans le texte, sans ponctuation finale', () => {
    expect(linkifyParts('Voir https://wiki.example/page?id=3. Merci')).toEqual([
      { kind: 'text', value: 'Voir ' },
      { kind: 'url', value: 'https://wiki.example/page?id=3' },
      { kind: 'text', value: '. Merci' },
    ]);
    expect(linkifyParts('rien')).toEqual([{ kind: 'text', value: 'rien' }]);
    expect(linkifyParts('(http://a.example/x)')).toEqual([
      { kind: 'text', value: '(' },
      { kind: 'url', value: 'http://a.example/x' },
      { kind: 'text', value: ')' },
    ]);
  });

  it('noms d’entités connues cliquables, en entier seulement', () => {
    const apps = [
      { id: 'application:atlas', name: 'Atlas' },
      { id: 'application:atlas-paiements', name: 'Atlas Paiements' },
      { id: 'application:x', name: 'X' },
    ];
    expect(splitAnswer('Si Atlas Paiements tombe, Atlas et Atlassian aussi ; voir https://doc.example/a.', apps)).toEqual([
      { kind: 'text', value: 'Si ' },
      { kind: 'entity', value: 'Atlas Paiements', id: 'application:atlas-paiements' },
      { kind: 'text', value: ' tombe, ' },
      { kind: 'entity', value: 'Atlas', id: 'application:atlas' },
      { kind: 'text', value: ' et Atlassian aussi ; voir ' },
      { kind: 'url', value: 'https://doc.example/a' },
      { kind: 'text', value: '.' },
    ]);
    expect(splitAnswer('X (Y)', apps)).toEqual([{ kind: 'text', value: 'X (Y)' }]);
    expect(splitAnswer('srv-atlas-01', [{ id: 's', name: 'atlas' }])).toEqual([{ kind: 'text', value: 'srv-atlas-01' }]);
  });

  it('entités consultées par les outils', () => {
    const trace = [
      { tool: 'search_entities', args: { query: 'atlas' } },
      { tool: 'impact_analysis', args: { id: 'application:atlas-paiements', max_depth: 4 } },
      { tool: 'dependencies', args: { id: 'application:atlas-paiements' } },
      { tool: 'dependencies', args: { id: 'server:srv-a' } },
      { tool: 'dependencies', args: { id: 'database:db1' } },
      null,
    ];
    expect(traceEntities(trace)).toEqual([
      { id: 'application:atlas-paiements', type: 'application' },
      { id: 'server:srv-a', type: 'server' },
    ]);
    expect(traceEntities('x')).toEqual([]);
    expect(traceTools(trace)).toEqual(['search_entities', 'impact_analysis', 'dependencies']);
  });

  it('historique sans erreurs, limité', () => {
    const msgs = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'err', error: true },
      { role: 'assistant' as const, content: 'b' },
    ];
    expect(historyOf(msgs)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(historyOf(msgs, 1)).toEqual([{ role: 'assistant', content: 'b' }]);
  });
});
