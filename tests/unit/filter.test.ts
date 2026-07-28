import { describe, it, expect } from 'vitest';
import { applyFilters, ALL_LEVELS_ON } from '../../src/client/filter.js';
import type { LogEntry, Level } from '../../src/shared/types.js';

let seq = 0;
const entry = (level: Level, component: string, message: string, trace: string[] = []): LogEntry => ({
  seq: ++seq, ts: null, level, thread: null, component, message, trace, traceTruncated: false,
});

const base = { levels: ALL_LEVELS_ON(), component: null, search: '' };

describe('applyFilters', () => {
  const entries = [
    entry('info', 'A.B', 'playback started'),
    entry('error', 'C.D', 'database is locked', ['   at Foo()']),
    entry('warn', 'A.B', 'slow response'),
  ];

  it('returns everything with default filters', () => {
    expect(applyFilters(entries, base)).toHaveLength(3);
  });

  it('filters by level', () => {
    const result = applyFilters(entries, { ...base, levels: new Set<Level>(['error']) });
    expect(result.map((e) => e.message)).toEqual(['database is locked']);
  });

  it('filters by component', () => {
    const result = applyFilters(entries, { ...base, component: 'A.B' });
    expect(result).toHaveLength(2);
  });

  it('searches message text case-insensitively', () => {
    expect(applyFilters(entries, { ...base, search: 'DATABASE' })).toHaveLength(1);
  });

  it('searches inside stack traces too', () => {
    expect(applyFilters(entries, { ...base, search: 'at Foo' })).toHaveLength(1);
  });

  it('searches the component name', () => {
    expect(applyFilters(entries, { ...base, search: 'C.D' })).toHaveLength(1);
  });

  it('combines filters with AND semantics', () => {
    const result = applyFilters(entries, { ...base, levels: new Set<Level>(['warn']), component: 'A.B' });
    expect(result.map((e) => e.message)).toEqual(['slow response']);
  });

  it('returns an empty array when no level is enabled', () => {
    expect(applyFilters(entries, { ...base, levels: new Set<Level>() })).toEqual([]);
  });
});
