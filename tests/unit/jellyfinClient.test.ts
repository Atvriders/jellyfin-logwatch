import { describe, it, expect, vi } from 'vitest';
import {
  JellyfinClient, JellyfinAuthError, JellyfinUnreachableError,
} from '../../src/server/jellyfinClient.js';

const make = (impl: typeof fetch) =>
  new JellyfinClient({ baseUrl: 'http://jf:8096', apiKey: 'KEY', fetchImpl: impl });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('JellyfinClient', () => {
  it('lists enabled users and reports avatar availability', async () => {
    const impl = vi.fn(async () => json([
      { Id: '1', Name: 'james', PrimaryImageTag: 'tag', Policy: { IsDisabled: false } },
      { Id: '2', Name: 'guest', Policy: { IsDisabled: false } },
      { Id: '3', Name: 'old', Policy: { IsDisabled: true } },
    ])) as unknown as typeof fetch;
    const users = await make(impl).listUsers();
    expect(users).toEqual([
      { id: '1', name: 'james', hasAvatar: true },
      { id: '2', name: 'guest', hasAvatar: false },
    ]);
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://jf:8096/Users');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Emby-Token': 'KEY' });
  });

  it('sends the MediaBrowser Authorization header when authenticating', async () => {
    const impl = vi.fn(async () => json({
      AccessToken: 'tok', User: { Id: '1', Name: 'james' },
    })) as unknown as typeof fetch;
    const result = await make(impl).authenticate('james', 'pw');
    expect(result).toEqual({ userId: '1', name: 'james', token: 'tok' });
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://jf:8096/Users/AuthenticateByName');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toContain('MediaBrowser Client="Jellyfin Logwatch"');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ Username: 'james', Pw: 'pw' });
  });

  it('throws JellyfinAuthError on 401', async () => {
    const impl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'bad')).rejects.toBeInstanceOf(JellyfinAuthError);
  });

  it('throws JellyfinUnreachableError when fetch rejects', async () => {
    const impl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'pw')).rejects.toBeInstanceOf(JellyfinUnreachableError);
    await expect(make(impl).listUsers()).rejects.toBeInstanceOf(JellyfinUnreachableError);
  });

  it('throws JellyfinUnreachableError on a 5xx', async () => {
    const impl = vi.fn(async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'pw')).rejects.toBeInstanceOf(JellyfinUnreachableError);
  });

  it('revokes a token with that token, not the API key, and swallows failures', async () => {
    const impl = vi.fn(async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    await make(impl).revoke('tok');
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://jf:8096/Sessions/Logout');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Emby-Token': 'tok' });

    const failing = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    await expect(make(failing).revoke('tok')).resolves.toBeUndefined();
  });

  it('returns null for a missing avatar', async () => {
    const impl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await make(impl).fetchAvatar('1')).toBeNull();
  });

  it('returns avatar bytes and content type', async () => {
    const impl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/png' },
    })) as unknown as typeof fetch;
    const avatar = await make(impl).fetchAvatar('1');
    expect(avatar!.contentType).toBe('image/png');
    expect([...avatar!.body]).toEqual([1, 2, 3]);
  });
});
