import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LineParser } from '../../src/server/logParser.js';

const opts = { maxTraceLines: 500, fallbackDate: () => '2026-07-26' };
const parse = (lines: string[], o = opts) => {
  const p = new LineParser(o);
  return [...p.write(lines), ...p.flush()];
};

describe('LineParser', () => {
  it('parses the primary Jellyfin file template', () => {
    const [e] = parse([
      '[2026-07-26 22:14:05.001 -05:00] [INF] [7] Emby.Server.Implementations.Session.SessionManager: Playback start',
    ]);
    expect(e).toMatchObject({
      level: 'info',
      thread: 7,
      component: 'Emby.Server.Implementations.Session.SessionManager',
      message: 'Playback start',
      trace: [],
      traceTruncated: false,
    });
    expect(e!.ts).toBe(new Date('2026-07-26T22:14:05.001-05:00').toISOString());
  });

  it('folds a 60-line stack trace into ONE entry', () => {
    const lines = readFileSync('tests/fixtures/efcore-trace.log', 'utf8')
      .split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(61);
    const entries = parse(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('error');
    expect(entries[0]!.trace).toHaveLength(60);
    expect(entries[0]!.traceTruncated).toBe(false);
  });

  it('maps every Serilog level code', () => {
    const codes: Array<[string, string]> = [
      ['VRB', 'verbose'], ['DBG', 'debug'], ['INF', 'info'],
      ['WRN', 'warn'], ['ERR', 'error'], ['FTL', 'fatal'],
    ];
    for (const [code, level] of codes) {
      const [e] = parse([`[2026-07-26 01:02:03.000 +00:00] [${code}] [1] A.B: m`]);
      expect(e!.level).toBe(level);
    }
  });

  it('does not let a message containing ": " swallow the component', () => {
    const [e] = parse([
      '[2026-07-26 01:02:03.000 +00:00] [WRN] [3] Jellyfin.Api.Http: GET /Items: 404 Not Found',
    ]);
    expect(e!.component).toBe('Jellyfin.Api.Http');
    expect(e!.message).toBe('GET /Items: 404 Not Found');
  });

  it('parses the date-less console template using the fallback date', () => {
    const [e] = parse(['[22:14:07] [INF] [SessionManager] Session ended']);
    expect(e!.component).toBe('SessionManager');
    expect(e!.message).toBe('Session ended');
    expect(e!.ts!.startsWith('2026-07-26')).toBe(true);
    expect(e!.thread).toBeNull();
  });

  it('emits an orphan continuation as a raw entry', () => {
    const entries = parse(['   at Some.Method()', '[2026-07-26 01:02:03.000 +00:00] [INF] [1] A.B: ok']);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'raw', message: '   at Some.Method()', ts: null, component: null });
    expect(entries[1]!.level).toBe('info');
  });

  it('caps the trace and flags truncation', () => {
    const lines = ['[2026-07-26 01:02:03.000 +00:00] [ERR] [1] A.B: boom',
      ...Array.from({ length: 10 }, (_, i) => `   at F${i}()`)];
    const [e] = parse(lines, { ...opts, maxTraceLines: 4 });
    expect(e!.trace).toHaveLength(5);
    expect(e!.trace[4]).toBe('… 6 more lines truncated');
    expect(e!.traceTruncated).toBe(true);
  });

  it('holds the open entry until the next start line or flush', () => {
    const p = new LineParser(opts);
    expect(p.write(['[2026-07-26 01:02:03.000 +00:00] [INF] [1] A.B: one'])).toHaveLength(0);
    expect(p.write(['[2026-07-26 01:02:04.000 +00:00] [INF] [1] A.B: two'])).toHaveLength(1);
    expect(p.flush()).toHaveLength(1);
    expect(p.flush()).toHaveLength(0);
  });

  it('never drops a line: an unparseable first line still surfaces', () => {
    const entries = parse(['total garbage \x00 bytes']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe('total garbage \x00 bytes');
    expect(entries[0]!.level).toBe('raw');
  });

  it('treats an unknown level code as raw but keeps the message', () => {
    const [e] = parse(['[2026-07-26 01:02:03.000 +00:00] [XYZ] [1] A.B: hmm']);
    expect(e!.level).toBe('raw');
    expect(e!.message).toBe('hmm');
  });
});
