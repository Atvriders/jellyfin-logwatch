import { useCallback, useEffect, useState } from 'react';
import { getSession, logout as apiLogout } from './api.js';
import { Login } from './components/Login.js';
import { Dashboard } from './components/Dashboard.js';

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void getSession()
      .then((session) => setUsername(session.username))
      .catch(() => setUsername(null))
      .finally(() => setReady(true));
  }, []);

  const handleLogout = useCallback(async () => {
    await apiLogout();
    setUsername(null);
  }, []);

  if (!ready) return <div className="boot">Connecting…</div>;
  if (!username) return <Login onAuthenticated={setUsername} />;
  return <Dashboard username={username} onLogout={handleLogout} />;
}
