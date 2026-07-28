import { useEffect, useState } from 'react';
import type { LoginUser } from '../../shared/types.js';
import { getUsers, login } from '../api.js';
import { Sparkline } from './Sparkline.js';

/**
 * The instrument in standby: the same chassis, the same meter, printed but
 * unlit, and the tape below it carrying account rows instead of log lines.
 * There is genuinely no data until someone authenticates, so every readout
 * reads as a dash rather than a zero.
 */

const UNREACHABLE = 'Jellyfin is unreachable — nobody can sign in until it is back.';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong password.',
  jellyfin_unreachable: UNREACHABLE,
  locked_out: 'Too many failed attempts. Try again later.',
  missing_credentials: 'Enter a password.',
  login_failed: 'Sign-in failed.',
};

export function Login({ onAuthenticated }: { onAuthenticated: (username: string) => void }) {
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [selected, setSelected] = useState<LoginUser | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void getUsers()
      .then(setUsers)
      .catch(() => setListError(true))
      .finally(() => setLoaded(true));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const result = await login(selected.name, password);
    setBusy(false);
    if (result.ok) { onAuthenticated(selected.name); return; }
    setPassword('');
    setError(MESSAGES[result.error] ?? MESSAGES.login_failed!);
  };

  // One alert channel, printed on the tape in the machine's own hand.
  const alert = error ?? (listError ? UNREACHABLE : null);
  const selectedSlot = selected ? users.findIndex((user) => user.id === selected.id) : -1;

  return (
    <div className="standby">
      <StandbyMeter />

      {/* sits in the filter rail's slot, so the tape starts at the same y */}
      <p className="standby__divider">{selected ? 'password' : 'select account'}</p>

      <section className="standby__panel">
        {selected ? (
          <form className="standby__rows" onSubmit={submit}>
            {/* the row you just picked, still where you picked it */}
            <div className="standby__row">
              <span className="standby__index" aria-hidden="true">{slot(selectedSlot)}</span>
              <span className="standby__body">
                <Avatar user={selected} />
                <span className="standby__name">{selected.name}</span>
                <span className="standby__hint" aria-hidden="true">selected</span>
              </span>
            </div>

            <div className="standby__row standby__row--input">
              <span className="standby__index" aria-hidden="true" />
              <span className="standby__body">
                <input
                  className="standby__password"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  aria-label="Password"
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="standby__back"
                  onClick={() => { setSelected(null); setError(null); setPassword(''); }}
                >
                  Back
                </button>
                <button type="submit" className="standby__submit" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </span>
            </div>
          </form>
        ) : (
          <ul className="standby__rows">
            {users.map((user, index) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="standby__row"
                  onClick={() => { setSelected(user); setError(null); }}
                >
                  <span className="standby__index" aria-hidden="true">{slot(index)}</span>
                  <span className="standby__body">
                    <Avatar user={user} />
                    <span className="standby__name">{user.name}</span>
                    <span className="standby__hint" aria-hidden="true">select</span>
                  </span>
                </button>
              </li>
            ))}
            {loaded && !listError && users.length === 0 && (
              <li>
                <div className="standby__row">
                  <span className="standby__index" aria-hidden="true">—</span>
                  <span className="standby__body"><span className="standby__idle">no accounts</span></span>
                </div>
              </li>
            )}
          </ul>
        )}

        {alert && <p className="standby__alert" role="alert">{alert}</p>}

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

function Avatar({ user }: { user: LoginUser }) {
  if (user.hasAvatar) {
    return <img className="standby__avatar" src={`/api/users/${user.id}/avatar`} alt="" />;
  }
  return (
    <span className="standby__avatar standby__avatar--initial" aria-hidden="true">
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const slot = (index: number) => String(Math.max(0, index) + 1).padStart(2, '0');
