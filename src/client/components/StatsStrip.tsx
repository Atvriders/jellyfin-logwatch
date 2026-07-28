import { type SourceState, type Stats } from '../../shared/types.js';
import { Sparkline } from './Sparkline.js';

/** Full-scale deflection of the error meter, in errors per window. */
const FULL_SCALE = 20;

export type LinkState = 'live' | 'lost' | 'opening';

const LINK_TEXT: Record<LinkState, string> = {
  live: 'live',
  lost: 'Reconnecting…',
  opening: 'linking',
};

export function StatsStrip({ stats, source, link }: {
  stats: Stats | null;
  source: SourceState;
  link: LinkState;
}) {
  const errors = (stats?.counts.error ?? 0) + (stats?.counts.fatal ?? 0);
  const fatal = stats?.counts.fatal ?? 0;
  const warns = stats?.counts.warn ?? 0;
  const windowMinutes = stats?.windowMinutes ?? 15;
  const spark = stats?.sparkline ?? Array<number>(windowMinutes).fill(0);
  const volume = spark.reduce((total, value) => total + value, 0);
  const peak = Math.max(0, ...spark);
  const overScale = errors > FULL_SCALE;
  const deflection = Math.min(1, errors / FULL_SCALE);
  const topComponents = stats?.topComponents ?? [];
  const loudest = Math.max(1, ...topComponents.map((item) => item.count));

  return (
    <header className="meter">
      <div className="meter__id">
        <span className="meter__mark">Jellyfin Logwatch</span>
        <span className="meter__file" title={source.file ?? undefined}>
          {source.waiting ? 'no source' : source.file ?? '—'}
        </span>
      </div>

      {/* The two numerals that have to carry across the room. */}
      <div className="meter__readouts">
        <div className={`readout readout--err ${errors === 0 ? 'is-rest' : ''}`}>
          <span className="readout__deflection">
            <span className="readout__value">{errors}</span>
            {/* the clip lamp: printed even when dark, lit only when it clipped */}
            <span className={`clip ${fatal > 0 ? 'is-lit' : ''}`}>fatal {fatal}</span>
          </span>
          <span className="readout__label">errors</span>
        </div>

        <div className={`readout readout--wrn ${warns === 0 ? 'is-rest' : ''}`}>
          <span className="readout__value">{warns}</span>
          <span className="readout__label">warnings</span>
        </div>
      </div>

      <section className="meter__load">
        <span className="cell__label">error load<span className="cell__window"> · {windowMinutes} min</span></span>
        <div className={`load ${overScale ? 'is-over' : ''}`}>
          <div
            className="load__track"
            role="meter"
            aria-valuenow={errors}
            aria-valuemin={0}
            aria-valuemax={FULL_SCALE}
            aria-label={`Errors in the last ${windowMinutes} minutes`}
          >
            <span className="load__tick" style={{ left: '25%' }} aria-hidden="true" />
            <span className="load__tick" style={{ left: '50%' }} aria-hidden="true" />
            <span className="load__tick" style={{ left: '75%' }} aria-hidden="true" />
            <div className="load__fill" style={{ width: `${(deflection * 100).toFixed(2)}%` }} />
          </div>
          <div className="load__scale" aria-hidden="true">
            <span>0</span>
            <span>10</span>
            <span>20+</span>
          </div>
        </div>
      </section>

      <section className="meter__volume">
        <span className="cell__label">volume</span>
        <Sparkline values={spark} />
        <span className="cell__foot">{volume} lines · peak {peak}</span>
      </section>

      <section className="meter__legend">
        <span className="cell__label">noisiest</span>
        <ul className="legend">
          {topComponents.length === 0 && <li className="legend__idle">quiet</li>}
          {topComponents.map((item) => (
            <li key={item.component} className="legend__item">
              <span className="legend__row">
                <span className="legend__name" title={item.component}>{shortComponent(item.component)}</span>
                <span className="legend__count">{item.count}</span>
              </span>
              <span
                className="legend__bar"
                style={{ width: `${((item.count / loudest) * 100).toFixed(1)}%` }}
                aria-hidden="true"
              />
            </li>
          ))}
        </ul>
      </section>

      <div className="meter__link">
        <span className={`link link--${link}`}>
          <span className="lamp" aria-hidden="true" />
          {LINK_TEXT[link]}
        </span>
      </div>
    </header>
  );
}

function shortComponent(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] ?? name;
}
