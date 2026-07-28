import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/server/config.js';

// No JELLYFIN_API_KEY: the app reads no admin-scoped credential any more, so a
// minimal working environment is a URL and a session secret.
const base = {
  JELLYFIN_URL: 'http://jellyfin.test:8096/',
  SESSION_SECRET: 's3cret',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.logDir).toBe('/logs');
    expect(cfg.port).toBe(3000);
    expect(cfg.bufferSize).toBe(5000);
    expect(cfg.pollIntervalMs).toBe(750);
    expect(cfg.rescanIntervalMs).toBe(5000);
    expect(cfg.startupTailBytes).toBe(262144);
    expect(cfg.maxTraceLines).toBe(500);
    expect(cfg.trustProxy).toBe(false);
  });

  it('strips a trailing slash from the Jellyfin URL', () => {
    expect(loadConfig({ ...base }).jellyfinUrl).toBe('http://jellyfin.test:8096');
  });

  it('starts with no JELLYFIN_API_KEY in the environment', () => {
    expect(Object.keys(base)).not.toContain('JELLYFIN_API_KEY');
    const cfg = loadConfig({ ...base });
    expect(Object.keys(cfg)).not.toContain('jellyfinApiKey');
    // Nothing quietly kept it under another name either.
    expect(Object.keys(cfg).filter((k) => /api.?key/i.test(k))).toEqual([]);
  });

  it('ignores a leftover JELLYFIN_API_KEY instead of failing to start', () => {
    // The owner's deployed docker-compose.yml still sets it. An unknown extra
    // variable must be ignored, never fatal, or the running container stops
    // booting the moment this version is pulled.
    const leftover = { ...base, JELLYFIN_API_KEY: 'left-over-admin-key' };
    expect(() => loadConfig(leftover)).not.toThrow();
    expect(loadConfig(leftover)).toEqual(loadConfig({ ...base }));
    // And it is not merely unvalidated — the value never reaches the config.
    expect(Object.values(loadConfig(leftover))).not.toContain('left-over-admin-key');
    // An empty one is equally harmless: it is no longer a variable we read.
    expect(() => loadConfig({ ...base, JELLYFIN_API_KEY: '' })).not.toThrow();
  });

  it('names the missing variable', () => {
    for (const name of ['JELLYFIN_URL', 'SESSION_SECRET'] as const) {
      expect(() => loadConfig({ ...base, [name]: '' })).toThrow(new RegExp(name));
      expect(() => loadConfig({ ...base, [name]: '' })).toThrow(ConfigError);
    }
  });

  it('rejects a non-numeric or non-positive override', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, BUFFER_SIZE: '0' })).toThrow(/BUFFER_SIZE/);
  });

  it('treats TRUST_PROXY=1 as true and anything else as false', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });
});
