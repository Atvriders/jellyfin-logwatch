import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/server/config.js';

const base = {
  JELLYFIN_URL: 'http://jellyfin.test:8096/',
  JELLYFIN_API_KEY: 'abc123',
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

  it('names the missing variable', () => {
    expect(() => loadConfig({ ...base, JELLYFIN_API_KEY: '' }))
      .toThrow(/JELLYFIN_API_KEY/);
    expect(() => loadConfig({ ...base, JELLYFIN_API_KEY: '' }))
      .toThrow(ConfigError);
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
