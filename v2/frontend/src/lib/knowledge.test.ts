import { describe, expect, it } from 'vitest';
import { groupKnowledge, kindKey, safeUrl, sourceBadges, sourceView, validDate, type KnowledgeItem, type SourceItem } from './knowledge';

const src = (o: Partial<SourceItem> = {}): SourceItem => ({
  id: 'fiche:1',
  kind: 'procedure',
  title: 'Redémarrer le service Atlas',
  url: 'https://wiki.example/p/1',
  appNames: ['Atlas', 'Marelle'],
  old: false,
  replaced: false,
  otherApplication: false,
  ...o,
});

const item = (id: string, kind: string, updatedAt: string | null, o: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id,
  kind,
  title: `Fiche ${id}`,
  period: null,
  updatedAt,
  url: `https://wiki.example/${id}`,
  old: false,
  replaced: false,
  ...o,
});

describe('knowledge', () => {
  it('sources render kind, title, app and date', () => {
    const v = sourceView(src({ updatedAt: '2026-03-02T10:00:00Z' }));
    expect(v.kindKey).toBe('knowledge.kind.procedure');
    expect(v.title).toBe('Redémarrer le service Atlas');
    expect(v.apps).toEqual(['Atlas', 'Marelle']);
    expect(v.date).toBe('2026-03-02T10:00:00Z');
    expect(v.url).toBe('https://wiki.example/p/1');
    expect(sourceView(src()).date).toBeNull();
    expect(sourceView(src({ kind: 'page' })).kindKey).toBe('knowledge.kind.page');
    expect(sourceView(src({ kind: 'inconnu' })).kindKey).toBe('knowledge.kind.page');
    expect(sourceView(src({ title: '', url: null })).url).toBeNull();
  });

  it('old, replaced and other application badges', () => {
    expect(sourceBadges(src())).toEqual([]);
    expect(sourceBadges(src({ old: true }))).toEqual([{ key: 'knowledge.badge.old', tone: 'warn' }]);
    expect(sourceBadges(src({ replaced: true })).map((b) => b.key)).toEqual(['knowledge.badge.replaced']);
    expect(sourceBadges(src({ old: true, replaced: true, otherApplication: true })).map((b) => b.key)).toEqual([
      'knowledge.badge.old',
      'knowledge.badge.replaced',
      'knowledge.badge.otherApp',
    ]);
    expect(sourceBadges({ old: true })).toHaveLength(1);
  });

  it('knowledge block groups by kind, newest first', () => {
    const groups = groupKnowledge([
      item('a', 'incident', '2026-01-01'),
      item('b', 'procedure', '2026-02-01'),
      item('c', 'procedure', '2026-05-01'),
      item('d', 'pratique', null),
      item('e', 'procedure', null),
      item('f', 'correctif', '2026-03-01'),
      item('g', 'bizarre', '2026-03-01'),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['procedure', 'incident', 'correctif', 'pratique']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['c', 'b', 'e']);
    expect(groups.find((g) => g.kind === 'pratique')?.items.map((i) => i.id)).toEqual(['d']);
    expect(kindKey('incident')).toBe('knowledge.kind.incident');
  });

  it('no knowledge shows an empty state', () => {
    expect(groupKnowledge([])).toEqual([]);
    expect(groupKnowledge(undefined)).toEqual([]);
  });

  it('safeUrl keeps only http and https', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('/relative/page')).toBeNull();
    expect(safeUrl('pas une adresse')).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl('http://wiki.example/a')).toBe('http://wiki.example/a');
    expect(safeUrl('HTTPS://wiki.example/a')).toBe('HTTPS://wiki.example/a');
    expect(sourceView(src({ url: 'javascript:alert(1)' })).url).toBeNull();
  });

  it('unparseable date is not shown', () => {
    expect(validDate('pas une date')).toBeNull();
    expect(validDate('2026-03-02')).toBe('2026-03-02');
    expect(sourceView(src({ updatedAt: 'n importe quoi' })).date).toBeNull();
  });
});
