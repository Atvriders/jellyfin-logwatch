import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogEntry } from '../../shared/types.js';
import { EntryRow } from './EntryRow.js';

const AT_BOTTOM_PX = 40;

const MINUTE = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const minuteOf = (entry: LogEntry | undefined): string | null =>
  entry && entry.ts ? MINUTE.format(new Date(entry.ts)) : null;

export function Feed({
  entries,
  rotations,
  following,
  onFollowChange,
  onSelectComponent,
  waiting = false,
  filtered = false,
  onClearFilters,
}: {
  entries: LogEntry[];
  rotations: number[];
  following: boolean;
  onFollowChange: (following: boolean) => void;
  onSelectComponent: (component: string) => void;
  /** No log file in the mounted directory yet. */
  waiting?: boolean;
  /** There are entries, but the current filters hide every one of them. */
  filtered?: boolean;
  onClearFilters?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rotationSet = new Set(rotations);
  const [expansions, setExpansions] = useState(0);
  const [resizes, setResizes] = useState(0);
  const reaching = useRef(0);

  /** The reader just touched the tape — wheel, drag, key or finger. */
  const noteReach = () => { reaching.current = Date.now() + 700; };

  // A viewport resize reflows every row; re-pin so a following feed does not
  // silently drift off the end.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizes((value) => value + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    // Measurements must follow the entry, not the slot: filtering reorders
    // rows and a stale height would let a tall row overlap its neighbour.
    getItemKey: (index) => entries[index]?.seq ?? index,
    estimateSize: () => 30,
    overscan: 12,
  });

  useEffect(() => {
    if (!following || entries.length === 0) return;
    const stick = () => {
      // Never yank the tape out of the reader's hand. These retries fire up to
      // 320ms after rows arrive, so without this guard a scroll-up during a
      // burst — precisely when you want to stop and read — gets snapped back to
      // the tail, and clearing `reaching` here would also swallow the scroll
      // event that should have paused following. Programmatic scrolls do not
      // fire wheel/pointer/touch/key events, so `reaching` is only ever set by
      // the reader and decays on its own.
      if (Date.now() <= reaching.current) return;
      virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
    };
    stick();
    // A row that just grew is measured asynchronously; re-stick once it has been.
    const timers = [40, 140, 320].map((delay) => setTimeout(stick, delay));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [entries.length, following, expansions, resizes, virtualizer]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < AT_BOTTOM_PX;
    if (atBottom === following) return;
    // Reaching the end always re-pins. Leaving it only counts when the reader
    // reached for the tape: rows arriving, rows growing as they are measured and
    // reflows after a resize all move the scroll position on their own, and none
    // of them mean "stop following".
    if (!atBottom && Date.now() > reaching.current) return;
    onFollowChange(atBottom);
  };

  return (
    <div
      className="feed"
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={noteReach}
      onPointerDown={noteReach}
      onTouchMove={noteReach}
      onKeyDown={noteReach}
      data-testid="feed"
    >
      {entries.length === 0 && (
        <div className="feed__empty">
          {waiting ? (
            <p className="feed__empty-text">
              No log file in /logs yet — check that the mount points at Jellyfin's log directory.
            </p>
          ) : filtered ? (
            <>
              <p className="feed__empty-text">Nothing matches these filters.</p>
              {onClearFilters && (
                <button type="button" className="feed__clear" onClick={onClearFilters}>
                  Clear filters
                </button>
              )}
            </>
          ) : (
            <p className="feed__empty-text">Waiting for the first line.</p>
          )}
        </div>
      )}

      <div className="feed__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = entries[item.index]!;
          const minute = minuteOf(entry);
          const previous = minuteOf(entries[item.index - 1]);
          return (
            <div
              key={entry.seq}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="feed__row"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {rotationSet.has(entry.seq) && <div className="feed__divider">new log file</div>}
              <EntryRow
                entry={entry}
                minute={minute !== previous ? minute : null}
                onSelectComponent={onSelectComponent}
                onToggleTrace={(open) => {
                  // Opening a stack trace is the reader reaching for the tape:
                  // stop following so the feed cannot scroll to the tail of the
                  // trace they just opened. The row stays exactly where it is
                  // and the trace grows downward from it.
                  if (open) onFollowChange(false);
                  setExpansions((value) => value + 1);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
