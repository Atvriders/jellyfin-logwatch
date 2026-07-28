/**
 * Chart-recorder trace: one sample per minute, drawn sample-and-hold (steps),
 * never interpolated — the buckets are discrete, so the pen must be too.
 * `unlit` prints the paper — rule and baseline — with no pen on it, for the
 * standby panel, where there is genuinely nothing to draw yet.
 */
export function Sparkline({ values, unlit = false }: {
  values: number[];
  unlit?: boolean;
  width?: number;
  height?: number;
}) {
  const samples = values.length > 0 ? values : [0];
  const max = Math.max(1, ...samples);
  const W = 100;
  const H = 30;
  const step = W / samples.length;

  const path: string[] = [];
  samples.forEach((value, index) => {
    const y = H - (Math.max(0, value) / max) * H;
    const x0 = index * step;
    const x1 = x0 + step;
    path.push(`${index === 0 ? 'M' : 'L'}${x0.toFixed(2)},${y.toFixed(2)}`);
    path.push(`L${x1.toFixed(2)},${y.toFixed(2)}`);
  });

  const last = samples[samples.length - 1] ?? 0;
  const penY = H - (Math.max(0, last) / max) * H;

  return (
    <svg
      className="trace"
      viewBox={`0 -1 ${W} ${H + 2}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={unlit ? 'Log volume per minute — nothing recorded yet' : `Log volume per minute, peak ${max} lines`}
    >
      <line className="trace__rule" x1="0" y1={H / 2} x2={W} y2={H / 2} vectorEffect="non-scaling-stroke" />
      <line className="trace__base" x1="0" y1={H} x2={W} y2={H} vectorEffect="non-scaling-stroke" />
      {!unlit && <path className="trace__pen" d={path.join(' ')} fill="none" vectorEffect="non-scaling-stroke" />}
      {!unlit && <line className="trace__now" x1={W} y1={penY} x2={W} y2={H} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
