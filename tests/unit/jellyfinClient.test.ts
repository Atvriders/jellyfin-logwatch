import { describe, it, expect, vi } from 'vitest';
import {
  JellyfinClient, JellyfinAuthError, JellyfinUnreachableError,
} from '../../src/server/jellyfinClient.js';

/**
 * The client takes no API key. The account picker was the only thing that
 * needed one, and it is gone along with `listUsers`/`fetchAvatar`, so every
 * request below is authenticated either by the credentials the user just typed
 * or by the short-lived token those credentials returned. Nothing here has
 * admin scope, which is the whole point of the change.
 */
const make = (impl: typeof fetch) =>
  new JellyfinClient({ baseUrl: 'http://jf:8096', fetchImpl: impl });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const callsOf = (impl: typeof fetch) => (impl as unknown as ReturnType<typeof vi.fn>).mock.calls;

describe('JellyfinClient', () => {
  it('sends the MediaBrowser Authorization header when authenticating', async () => {
    const impl = vi.fn(async () => json({
      AccessToken: 'tok', User: { Id: '1', Name: 'james' },
    })) as unknown as typeof fetch;
    const result = await make(impl).authenticate('james', 'pw');
    expect(result).toEqual({ userId: '1', name: 'james', token: 'tok' });
    const [url, init] = callsOf(impl)[0]!;
    expect(String(url)).toBe('http://jf:8096/Users/AuthenticateByName');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toContain('MediaBrowser Client="Jellyfin Logwatch"');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ Username: 'james', Pw: 'pw' });
  });

  it('throws JellyfinAuthError on 401', async () => {
    const impl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'bad')).rejects.toBeInstanceOf(JellyfinAuthError);
  });

  it('treats a 403 as a failed sign-in, not an outage', async () => {
    const impl = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'bad')).rejects.toBeInstanceOf(JellyfinAuthError);
  });

  // The rejection path lives in the private `call` helper. It used to be
  // covered through listUsers(); authenticate() is now the only caller, so the
  // coverage moves here rather than disappearing with the deleted method.
  it('throws JellyfinUnreachableError when fetch rejects', async () => {
    const impl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'pw')).rejects.toBeInstanceOf(JellyfinUnreachableError);
  });

  it('throws JellyfinUnreachableError on a 5xx', async () => {
    const impl = vi.fn(async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'pw')).rejects.toBeInstanceOf(JellyfinUnreachableError);
  });

  it('revokes a token with that token, not the API key, and swallows failures', async () => {
    const impl = vi.fn(async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    await make(impl).revoke('tok');
    const [url, init] = callsOf(impl)[0]!;
    expect(String(url)).toBe('http://jf:8096/Sessions/Logout');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Emby-Token': 'tok' });

    const failing = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    await expect(make(failing).revoke('tok')).resolves.toBeUndefined();
  });

  it('carries no credential the signing-in user did not just supply', async () => {
    const impl = vi.fn(async () => json({
      AccessToken: 'tok', User: { Id: '1', Name: 'james' },
    })) as unknown as typeof fetch;
    const client = make(impl);
    await client.authenticate('james', 'pw');
    await client.revoke('tok');

    // The auth call carries no token at all; the logout carries only the one
    // that call just issued. If an admin key ever reappears in this client,
    // one of these two slots is where it would show up.
    const tokens = callsOf(impl)
      .map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['X-Emby-Token']);
    expect(tokens).toEqual([undefined, 'tok']);
  });

  it('exposes no user-directory surface at all', () => {
    const client = make(vi.fn() as unknown as typeof fetch);
    // Deleted, not merely unused: a caller cannot reach a user list or an
    // avatar through this client, so no route can accidentally re-expose one.
    expect('listUsers' in client).toBe(false);
    expect('fetchAvatar' in client).toBe(false);
  });
});
