import { LEVELS, type Level } from '../../shared/types.js';
import type { Filters } from '../filter.js';

export function FilterBar({ filters, onChange, following, onToggleFollow, components }: {
  filters: Filters;
  onChange: (next: Filters) => void;
  following: boolean;
  onToggleFollow: () => void;
  components: string[];
}) {
  const toggleLevel = (level: Level) => {
    const levels = new Set(filters.levels);
    if (levels.has(level)) levels.delete(level); else levels.add(level);
    onChange({ ...filters, levels });
  };

  const errorsOnly = () => onChange({ ...filters, levels: new Set<Level>(['error', 'fatal']) });
  const allLevels = () => onChange({ ...filters, levels: new Set<Level>(LEVELS) });

  return (
    <div className="filters">
      <div className="filters__group filters__group--levels">
        <span className="filters__legend" aria-hidden="true">levels</span>
        <div className="filters__levels">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={filters.levels.has(level)}
              className={`filters__level filters__level--${level} ${filters.levels.has(level) ? 'is-on' : ''}`}
              onClick={() => toggleLevel(level)}
            >
              <span className="filters__led" aria-hidden="true" />
              {level}
            </button>
          ))}
        </div>
        <div className="filters__presets">
          <button type="button" className="filters__preset" onClick={errorsOnly}>errors only</button>
          <button type="button" className="filters__preset" onClick={allLevels}>all</button>
        </div>
      </div>

      <div className="filters__group filters__group--find">
        <span className="filters__legend" aria-hidden="true">find</span>
        <select
          className="filters__component"
          aria-label="Filter by component"
          value={filters.component ?? ''}
          onChange={(event) => onChange({ ...filters, component: event.target.value || null })}
        >
          <option value="">all components</option>
          {components.map((component) => <option key={component} value={component}>{component}</option>)}
        </select>

        <input
          className="filters__search"
          type="search"
          aria-label="Search messages and traces"
          placeholder="Search log text…"
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
        />
      </div>

      <button
        type="button"
        className={`filters__follow ${following ? 'is-on' : ''}`}
        aria-pressed={following}
        onClick={onToggleFollow}
      >
        <span className="filters__led" aria-hidden="true" />
        {following ? 'following' : 'paused'}
      </button>
    </div>
  );
}
