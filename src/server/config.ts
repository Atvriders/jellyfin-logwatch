export class ConfigError extends Error {}

// JELLYFIN_API_KEY used to be required, for the login screen's account picker.
// The picker is gone and nothing needs an admin-scoped credential any more, so
// the variable is no longer read. Deployed compose files still set it; unknown
// variables are ignored, never an error, so those keep starting unchanged.
export interface Config {
  jellyfinUrl: string;
  sessionSecret: string;
  logDir: string;
  port: number;
  bufferSize: number;
  pollIntervalMs: number;
  rescanIntervalMs: number;
  startupTailBytes: number;
  maxTraceLines: number;
  trustProxy: boolean;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `${name} is required. Set it in the environment block of your compose file — see .env.example for the full list.`,
    );
  }
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    jellyfinUrl: required(env, 'JELLYFIN_URL').replace(/\/+$/, ''),
    sessionSecret: required(env, 'SESSION_SECRET'),
    logDir: env.LOG_DIR?.trim() || '/logs',
    port: positiveInt(env, 'PORT', 3000),
    bufferSize: positiveInt(env, 'BUFFER_SIZE', 5000),
    pollIntervalMs: positiveInt(env, 'POLL_INTERVAL_MS', 750),
    rescanIntervalMs: positiveInt(env, 'RESCAN_INTERVAL_MS', 5000),
    startupTailBytes: positiveInt(env, 'STARTUP_TAIL_BYTES', 262144),
    maxTraceLines: positiveInt(env, 'MAX_TRACE_LINES', 500),
    trustProxy: env.TRUST_PROXY?.trim() === '1',
  };
}
