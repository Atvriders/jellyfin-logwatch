import type { SessionInfo, Snapshot } from '../shared/types.js';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`${input} → ${response.status}`);
  return (await response.json()) as T;
}

export const getSession = () => json<SessionInfo>('/api/session');
export const getSnapshot = (limit?: number) =>
  json<Snapshot>(`/api/snapshot${limit ? `?limit=${limit}` : ''}`);

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string; retryAfterMs?: number }> {
  const response = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => ({}))) as { error?: string; retryAfterMs?: number };
  return { ok: false, error: body.error ?? 'login_failed', retryAfterMs: body.retryAfterMs };
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
