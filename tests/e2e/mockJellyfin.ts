import { createServer, type Server } from 'node:http';

/**
 * A Jellyfin stand-in for the e2e run: it answers only the three endpoints
 * this app actually calls, so the suite proves our wiring rather than
 * Jellyfin's. `correct-horse` is the one password that works.
 */
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
        if (parsed.Pw === 'correct-horse') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            AccessToken: 'mock-access-token',
            ServerId: 'mock-server',
            User: { Id: '1', Name: parsed.Username ?? 'james' },
          }));
        } else {
          res.writeHead(401).end();
        }
      });
      return;
    }

    if (url === '/Users') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ Id: '1', Name: 'james', Policy: { IsDisabled: false } }]));
      return;
    }

    if (url === '/Sessions/Logout') { res.writeHead(204).end(); return; }

    // No avatar: the login rows fall back to the initial, which keeps the
    // "zero <img> elements" XSS assertion honest about where images come from.
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
