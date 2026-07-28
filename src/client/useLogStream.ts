import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry, SourceState, Stats } from '../shared/types.js';
import { getSnapshot } from './api.js';

const MAX_CLIENT_ENTRIES = 5000;

export function useLogStream(enabled: boolean) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [source, setSource] = useState<SourceState>({ file: null, waiting: true });
  const [connected, setConnected] = useState(false);
  const [rotations, setRotations] = useState<number[]>([]);
  const lastSeq = useRef(0);

  const resnapshot = useCallback(async () => {
    const snapshot = await getSnapshot();
    setEntries(snapshot.entries);
    setStats(snapshot.stats);
    setSource(snapshot.source);
    lastSeq.current = snapshot.lastSeq;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void resnapshot().catch(() => undefined);

    const stream = new EventSource('/api/stream', { withCredentials: true });
    stream.onopen = () => { if (!cancelled) setConnected(true); };
    stream.onerror = () => { if (!cancelled) setConnected(false); };

    stream.addEventListener('entries', (event) => {
      const incoming = JSON.parse((event as MessageEvent<string>).data) as LogEntry[];
      if (incoming.length === 0) return;
      lastSeq.current = incoming[incoming.length - 1]!.seq;
      setEntries((previous) => {
        const next = [...previous, ...incoming];
        return next.length > MAX_CLIENT_ENTRIES ? next.slice(next.length - MAX_CLIENT_ENTRIES) : next;
      });
    });

    stream.addEventListener('stats', (event) => {
      setStats(JSON.parse((event as MessageEvent<string>).data) as Stats);
    });

    stream.addEventListener('rotate', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { file: string };
      setSource((previous) => ({ ...previous, file: data.file, waiting: false }));
      setRotations((previous) => [...previous, lastSeq.current + 1]);
    });

    stream.addEventListener('waiting', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { waiting: boolean };
      setSource((previous) => ({ ...previous, waiting: data.waiting }));
    });

    stream.addEventListener('resnapshot', () => { void resnapshot().catch(() => undefined); });

    return () => { cancelled = true; stream.close(); };
  }, [enabled, resnapshot]);

  return { entries, stats, source, connected, rotations };
}
