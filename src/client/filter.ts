import { LEVELS, type Level, type LogEntry } from '../shared/types.js';

export interface Filters {
  levels: Set<Level>;
  component: string | null;
  search: string;
}

export const ALL_LEVELS_ON = (): Set<Level> => new Set<Level>(LEVELS);

export function applyFilters(entries: LogEntry[], filters: Filters): LogEntry[] {
  const needle = filters.search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!filters.levels.has(entry.level)) return false;
    if (filters.component && entry.component !== filters.component) return false;
    if (!needle) return true;
    if (entry.message.toLowerCase().includes(needle)) return true;
    if (entry.component?.toLowerCase().includes(needle)) return true;
    return entry.trace.some((line) => line.toLowerCase().includes(needle));
  });
}
