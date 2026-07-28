import type { LoginUser } from '../shared/types.js';

export class JellyfinUnreachableError extends Error {}
export class JellyfinAuthError extends Error {}

export const AUTH_HEADER =
  'MediaBrowser Client="Jellyfin Logwatch", Device="server", DeviceId="jellyfin-logwatch", Version="1.0.0"';

interface JellyfinUser {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
  Policy?: { IsDisabled?: boolean };
}

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class JellyfinClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JellyfinClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string { return `${this.opts.baseUrl}${path}`; }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), init);
    } catch (error) {
      throw new JellyfinUnreachableError(`Jellyfin request to ${path} failed: ${String(error)}`);
    }
  }

  async listUsers(): Promise<LoginUser[]> {
    const response = await this.call('/Users', {
      headers: { 'X-Emby-Token': this.opts.apiKey, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new JellyfinUnreachableError(`Jellyfin /Users returned ${response.status}`);
    }
    const users = (await response.json()) as JellyfinUser[];
    return users
      .filter((user) => user.Policy?.IsDisabled !== true)
      .map((user) => ({ id: user.Id, name: user.Name, hasAvatar: Boolean(user.PrimaryImageTag) }));
  }

  async authenticate(username: string, password: string): Promise<{ userId: string; name: string; token: string }> {
    const response = await this.call('/Users/AuthenticateByName', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new JellyfinAuthError('Invalid username or password');
    }
    if (!response.ok) {
      throw new JellyfinUnreachableError(`Jellyfin authentication returned ${response.status}`);
    }
    const body = (await response.json()) as { AccessToken: string; User: { Id: string; Name: string } };
    return { userId: body.User.Id, name: body.User.Name, token: body.AccessToken };
  }

  async revoke(token: string): Promise<void> {
    try {
      await this.fetchImpl(this.url('/Sessions/Logout'), {
        method: 'POST',
        headers: { 'X-Emby-Token': token, Authorization: AUTH_HEADER },
      });
    } catch {
      // Best effort: the token expires on its own; never fail a login over this.
    }
  }

  async fetchAvatar(userId: string): Promise<{ body: Buffer; contentType: string } | null> {
    const response = await this.call(`/Users/${encodeURIComponent(userId)}/Images/Primary`, {
      headers: { 'X-Emby-Token': this.opts.apiKey },
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return { body: buffer, contentType: response.headers.get('content-type') ?? 'image/jpeg' };
  }
}
