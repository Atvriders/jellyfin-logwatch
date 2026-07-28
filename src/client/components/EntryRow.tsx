import { useState } from 'react';
import type { LogEntry } from '../../shared/types.js';

/**
 * The minute lives in the time spine (left gutter) and is printed only when it
 * changes, so the row itself prints seconds — the two read together as HH:MM:SS
 * across the spine.
 */
const seconds = (iso: string | null): string =>
  iso ? `:${String(new Date(iso).getSeconds()).padStart(2, '0')}` : ':--';

function shortComponent(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] ?? name;
}

export function EntryRow({ entry, minute, onSelectComponent, onToggleTrace }: {
  entry: LogEntry;
  /** Printed in the gutter only when the minute changed from the row above. */
  minute: string | null;
  onSelectComponent: (component: string) => void;
  onToggleTrace?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const component = entry.component;
  const traceId = `trace-${entry.seq}`;

  return (
    <article className={`entry entry--${entry.level}`} data-testid="entry">
      <div className="entry__gutter">
        {minute && (
          <time className="entry__minute" dateTime={entry.ts ?? undefined}>{minute}</time>
        )}
      </div>

      <div className="entry__body">
        <div className="entry__head">
          <span className="entry__sec">{seconds(entry.ts)}</span>
          <span className={`entry__level entry__level--${entry.level}`}>{entry.level}</span>
          <span className="entry__source">
            {component && (
              <button
                type="button"
                className="entry__component"
                title={component}
                onClick={() => onSelectComponent(component)}
              >
                {shortComponent(component)}
              </button>
            )}
          </span>
          <span className="entry__message">{entry.message}</span>
        </div>

        {entry.trace.length > 0 && (
          <>
            <button
              type="button"
              className="entry__toggle"
              aria-expanded={open}
              aria-controls={traceId}
              onClick={() => { setOpen(!open); onToggleTrace?.(!open); }}
            >
              {open ? '▾ hide' : `▸ ${entry.trace.length} more lines`}
              {entry.traceTruncated && ' (truncated)'}
            </button>
            {open && (
              <pre className="entry__trace" id={traceId} role="group" aria-label="Stack trace">
                {entry.trace.map((line, index) => (
                  // One block per frame so long frames hang-indent instead of
                  // hiding themselves behind a horizontal scrollbar.
                  <span className="trace__line" key={index}>{line}</span>
                ))}
              </pre>
            )}
          </>
        )}
      </div>
    </article>
  );
}
