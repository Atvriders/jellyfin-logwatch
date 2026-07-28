import { describe, it, expect } from 'vitest';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import type { ParsedEntry } from '../../src/server/logParser.js';

const entry = (message: string): ParsedEntry => ({
  ts: null, level: 'info', thread: null, component: 'A.B',
  message, trace: [], traceTruncated: false,
});

describe('EntryBuffer', () => {
  it('assigns monotonic seq numbers starting at 1', () => {
    const buffer = new EntryBuffer(10);
    expect(buffer.add(entry('a')).seq).toBe(1);
    expect(buffer.add(entry('b')).seq).toBe(2);
    expect(buffer.lastSeq).toBe(2);
  });

  it('evicts oldest first and keeps seq monotonic across eviction', () => {
    const buffer = new EntryBuffer(3);
    buffer.addAll([entry('a'), entry('b'), entry('c'), entry('d')]);
    expect(buffer.snapshot().map((e) => e.message)).toEqual(['b', 'c', 'd']);
    expect(buffer.lastSeq).toBe(4);
    expect(buffer.size).toBe(3);
  });

  it('limits a snapshot to the newest N entries', () => {
    const buffer = new EntryBuffer(10);
    buffer.addAll([entry('a'), entry('b'), entry('c')]);
    expect(buffer.snapshot(2).map((e) => e.message)).toEqual(['b', 'c']);
  });

  it('replays entries newer than a seq still in the ring', () => {
    const buffer = new EntryBuffer(10);
    buffer.addAll([entry('a'), entry('b'), entry('c')]);
    expect(buffer.since(1)!.map((e) => e.message)).toEqual(['b', 'c']);
    expect(buffer.since(3)).toEqual([]);
  });

  it('returns null when the requested seq has been evicted', () => {
    const buffer = new EntryBuffer(2);
    buffer.addAll([entry('a'), entry('b'), entry('c')]);
    expect(buffer.since(1)).toBeNull();
  });

  it('accepts seq 0 on an empty buffer as a full replay', () => {
    const buffer = new EntryBuffer(5);
    expect(buffer.since(0)).toEqual([]);
    buffer.add(entry('a'));
    expect(buffer.since(0)!.map((e) => e.message)).toEqual(['a']);
  });
});
