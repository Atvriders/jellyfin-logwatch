export type Level =
  | 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'raw';

export const LEVELS: readonly Level[] = [
  'verbose', 'debug', 'info', 'warn', 'error', 'fatal', 'raw',
] as const;

export interface LogEntry {
  seq: number;
  ts: string | null;
  level: Level;
  thread: number | null;
  component: string | null;
  message: string;
  trace: string[];
  traceTruncated: boolean;
}

export interface Stats {
  windowMinutes: number;
  counts: Record<Level, number>;
  sparkline: number[];
  topComponents: Array<{ component: string; count: number }>;
  linesPerSecond: number;
}

export interface SourceState {
  file: string | null;
  waiting: boolean;
}

export interface Snapshot {
  entries: LogEntry[];
  stats: Stats;
  source: SourceState;
  lastSeq: number;
}

export interface SessionInfo {
  authenticated: boolean;
  username: string | null;
}

export type SseEventName =
  | 'entries' | 'stats' | 'rotate' | 'waiting' | 'resnapshot';
