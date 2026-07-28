import { useEffect, useMemo, useState } from 'react';
import { ALL_LEVELS_ON, applyFilters, type Filters } from '../filter.js';
import { useLogStream } from '../useLogStream.js';
import { FilterBar } from './FilterBar.js';
import { Feed } from './Feed.js';
import { StatsStrip, type LinkState } from './StatsStrip.js';

export function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  const { entries, stats, source, connected, rotations } = useLogStream(true);
  const [filters, setFilters] = useState<Filters>({ levels: ALL_LEVELS_ON(), component: null, search: '' });
  const [following, setFollowing] = useState(true);
  const [wasConnected, setWasConnected] = useState(false);

  useEffect(() => { if (connected) setWasConnected(true); }, [connected]);

  const visible = useMemo(() => applyFilters(entries, filters), [entries, filters]);
  const components = useMemo(
    () => [...new Set(entries.map((entry) => entry.component).filter((c): c is string => Boolean(c)))].sort(),
    [entries],
  );
  const hidden = entries.length - visible.length;
  // Only claim we are reconnecting once we have actually been connected.
  const link: LinkState = connected ? 'live' : wasConnected ? 'lost' : 'opening';

  return (
    <div className="dashboard">
      <StatsStrip stats={stats} source={source} link={link} />
      <FilterBar
        filters={filters}
        onChange={setFilters}
        following={following}
        onToggleFollow={() => setFollowing((value) => !value)}
        components={components}
      />
      <Feed
        entries={visible}
        rotations={rotations}
        following={following}
        onFollowChange={setFollowing}
        onSelectComponent={(component) => setFilters((f) => ({ ...f, component }))}
        waiting={source.waiting}
        filtered={entries.length > 0}
        onClearFilters={() => setFilters({ levels: ALL_LEVELS_ON(), component: null, search: '' })}
      />
      <footer className="dashboard__footer">
        <span className="dashboard__tally">
          {visible.length} shown{hidden > 0 ? ` · ${hidden} filtered out` : ''}
        </span>
        <span className="dashboard__user">{username}</span>
        <button type="button" className="dashboard__signout" onClick={onLogout}>Sign out</button>
      </footer>
    </div>
  );
}
