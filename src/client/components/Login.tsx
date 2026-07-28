import { useState } from 'react';
import { login } from '../api.js';
import { Sparkline } from './Sparkline.js';

/**
 * The instrument in standby: the same chassis, the same meter, printed but
 * unlit, and the tape below it carrying two field rows instead of log lines.
 * There is genuinely no data until someone authenticates, so every readout
 * reads as a dash rather than a zero.
 *
 * The panel never publishes who has an account here: you type the name, and a
 * failure says only that the pair was wrong.
 */

const UNREACHABLE = 'Jellyfin is unreachable — nobody can sign in until it is back.';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong username or password.',
  jellyfin_unreachable: UNREACHABLE,
  locked_out: 'Too many failed attempts. Try again later.',
  missing_credentials: 'Enter a username and password.',
  login_failed: 'Sign-in failed.',
};

export function Login({ onAuthenticated }: { onAuthenticated: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await login(username, password);
    setBusy(false);
    if (result.ok) { onAuthenticated(username); return; }
    // the name stays typed, the secret never does
    setPassword('');
    setError(MESSAGES[result.error] ?? MESSAGES.login_failed!);
  };

  return (
    <div className="standby">
      <StandbyMeter />

      {/* sits in the filter rail's slot, so the tape starts at the same y */}
      <p className="standby__divider">SIGN IN</p>

      <section className="standby__panel">
        <form className="standby__rows" onSubmit={submit}>
          <div className="standby__row standby__row--field">
            <span className="standby__index" aria-hidden="true">01</span>
            <span className="standby__body">
              <label className="standby__label" htmlFor="standby-username">username</label>
              <input
                id="standby-username"
                className="standby__field"
                type="text"
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </span>
          </div>

          <div className="standby__row standby__row--field">
            <span className="standby__index" aria-hidden="true">02</span>
            <span className="standby__body">
              <label className="standby__label" htmlFor="standby-password">password</label>
              <input
                id="standby-password"
                className="standby__field"
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </span>
          </div>

          {/* the one actuator, and the plate under it saying what fits here */}
          <div className="standby__row standby__row--actions">
            <span className="standby__index" aria-hidden="true" />
            <span className="standby__body">
              <span className="standby__label" aria-hidden="true" />
              <button type="submit" className="standby__submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <span className="standby__note">Any Jellyfin account on this server.</span>
            </span>
          </div>
        </form>

        {/* One alert channel, printed on the tape in the machine's own hand. */}
        {error && <p className="standby__alert" role="alert">{error}</p>}

        {/* the tape's own empty state, in the same place it always appears */}
        <div className="standby__void">
          <p className="feed__empty-text">Nothing is read from the log until you sign in.</p>
        </div>
      </section>

      <footer className="dashboard__footer">
        <span className="dashboard__tally">0 shown</span>
        <span className="dashboard__user">not signed in</span>
      </footer>
    </div>
  );
}

/**
 * The dashboard's meter, printed and unlit. Same cells, same order, same
 * widths — so signing in lights the numerals without moving a single rule.
 * The unlit cells are hidden from assistive tech: "standby" already says it.
 */
function StandbyMeter() {
  return (
    <header className="meter">
      <div className="meter__id">
        <h1 className="meter__mark">Jellyfin Logwatch</h1>
        <span className="meter__file">not connected</span>
      </div>

      {/* a dash, not a zero: a zero is a measurement, and nothing has been measured */}
      <div className="meter__readouts" aria-hidden="true">
        <div className="readout readout--err is-rest">
          <span className="readout__deflection">
            <span className="readout__value readout__value--unlit"><span className="readout__unlit">—</span></span>
            <span className="clip">fatal —</span>
          </span>
          <span className="readout__label">errors</span>
        </div>

        <div className="readout readout--wrn is-rest">
          <span className="readout__value readout__value--unlit"><span className="readout__unlit">—</span></span>
          <span className="readout__label">warnings</span>
        </div>
      </div>

      <section className="meter__load" aria-hidden="true">
        <span className="cell__label">error load</span>
        <div className="load">
          <div className="load__track">
            <span className="load__tick" style={{ left: '25%' }} />
            <span className="load__tick" style={{ left: '50%' }} />
            <span className="load__tick" style={{ left: '75%' }} />
          </div>
          <div className="load__scale">
            <span>0</span>
            <span>10</span>
            <span>20+</span>
          </div>
        </div>
      </section>

      <section className="meter__volume" aria-hidden="true">
        <span className="cell__label">volume</span>
        <Sparkline values={[]} unlit />
        <span className="cell__foot">— lines · peak —</span>
      </section>

      <section className="meter__legend" aria-hidden="true">
        <span className="cell__label">noisiest</span>
        <ul className="legend"><li className="legend__idle">—</li></ul>
      </section>

      {/* the one lamp that is honest in standby: unlit, in --floor */}
      <div className="meter__link">
        <span className="link link--standby">
          <span className="lamp" aria-hidden="true" />
          standby
        </span>
      </div>
    </header>
  );
}
