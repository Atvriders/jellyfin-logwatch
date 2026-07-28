import { createServer, type Server } from 'node:http';

/**
 * A Jellyfin stand-in for the e2e run: it answers only the two endpoints this
 * app still calls, so the suite proves our wiring rather than Jellyfin's.
 *
 * There is deliberately no `/Users` handler. The app has no API key and no
 * route that would list accounts; serving one here would let a regression that
 * re-introduced the account picker pass the suite.
 *
 * One account exists — `james` / `correct-horse`. Every other username or
 * password gets the same bare 401 a real Jellyfin returns, which is what makes
 * the "unknown user and wrong password look identical" assertion meaningful.
 */
const ACCOUNT = { username: 'james', password: 'correct-horse' };

export function startMockJellyfin(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';

    if (url.startsWith('/Users/AuthenticateByName')) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        let parsed: { Username?: string; Pw?: string } = {};
        try {
          parsed = JSON.parse(body || '{}') as { Username?: string; Pw?: string };
        } catch { /* malformed body is just a failed sign-in */ }
        if (parsed.Username === ACCOUNT.username && parsed.Pw === ACCOUNT.password) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            AccessToken: 'mock-access-token',
            ServerId: 'mock-server',
            User: { Id: '1', Name: parsed.Username },
          }));
        } else {
          res.writeHead(401).end();
        }
      });
      return;
    }

    if (url === '/Sessions/Logout') { res.writeHead(204).end(); return; }

    // Anything else — including /Users — does not exist as far as this app is
    // concerned. Nothing it does should ever land here.
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
