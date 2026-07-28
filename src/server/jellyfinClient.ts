export class JellyfinUnreachableError extends Error {}
export class JellyfinAuthError extends Error {}

export const AUTH_HEADER =
  'MediaBrowser Client="Jellyfin Logwatch", Device="server", DeviceId="jellyfin-logwatch", Version="1.0.0"';

/**
 * No API key. Every call this client makes is authenticated by the credentials
 * the user just typed (`/Users/AuthenticateByName`) or by the short-lived token
 * that call returned (`/Sessions/Logout`). Nothing here needs admin scope, so
 * the container never holds an admin-scoped credential.
 */
export interface JellyfinClientOptions {
  baseUrl: string;
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
}
