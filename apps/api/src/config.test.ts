import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'development',
      port: 4000,
      webOrigin: 'http://localhost:5173',
      supabase: null,
      stripe: null,
    });
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      WEB_ORIGIN: 'https://gather.example',
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    });
    expect(config).toEqual({
      nodeEnv: 'production',
      port: 8080,
      webOrigin: 'https://gather.example',
      supabase: { url: 'https://abc.supabase.co', serviceRoleKey: 'service-key' },
      stripe: null,
    });
  });

  it.each(['abc', '0', '65536', '-1', '3000.5'])('rejects invalid PORT "%s"', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/Invalid PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/Invalid NODE_ENV/);
  });

  describe('Supabase settings', () => {
    it('is null when neither variable is set (outside production)', () => {
      expect(loadConfig({ NODE_ENV: 'development' }).supabase).toBeNull();
    });

    it('reads the URL (normalised to its origin) and the service-role key together', () => {
      const config = loadConfig({
        SUPABASE_URL: 'https://abc.supabase.co/',
        SUPABASE_SERVICE_ROLE_KEY: '  service-key  ',
      });
      expect(config.supabase).toEqual({
        url: 'https://abc.supabase.co',
        serviceRoleKey: 'service-key',
      });
    });

    it('accepts a local http URL (Supabase CLI stack)', () => {
      expect(
        loadConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'k' })
          .supabase?.url,
      ).toBe('http://127.0.0.1:54321');
    });

    it('rejects exactly one of the two variables', () => {
      expect(() => loadConfig({ SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/together/);
      expect(() => loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toThrow(/together/);
    });

    it.each(['not a url', 'ftp://abc.supabase.co', 'abc.supabase.co'])(
      'rejects an invalid URL "%s"',
      (url) => {
        expect(() => loadConfig({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'k' })).toThrow(
          /SUPABASE_URL/,
        );
      },
    );

    it('is required in production: the API must not start without authentication', () => {
      expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/required in production/);
    });
  });

  describe('Stripe (test mode only, D-068)', () => {
    const keys = { STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };

    it('is null when neither secret is set', () => {
      expect(loadConfig({}).stripe).toBeNull();
      expect(loadConfig({ STRIPE_SECRET_KEY: '  ', STRIPE_WEBHOOK_SECRET: '' }).stripe).toBeNull();
    });

    it('reads a test secret key and a webhook secret', () => {
      expect(loadConfig(keys).stripe).toEqual({
        secretKey: 'sk_test_abc123',
        webhookSecret: 'whsec_abc123',
      });
    });

    it('accepts a restricted test key', () => {
      expect(loadConfig({ ...keys, STRIPE_SECRET_KEY: 'rk_test_abc123' }).stripe?.secretKey).toBe(
        'rk_test_abc123',
      );
    });

    it('requires both secrets or neither', () => {
      expect(() => loadConfig({ STRIPE_SECRET_KEY: keys.STRIPE_SECRET_KEY })).toThrow(
        /set together/,
      );
      expect(() => loadConfig({ STRIPE_WEBHOOK_SECRET: keys.STRIPE_WEBHOOK_SECRET })).toThrow(
        /set together/,
      );
    });

    it.each([
      'sk_live_abc123',
      'rk_live_abc123',
      'pk_test_abc123',
      'abc',
      'sk_test_',
      'sk_test_a b',
    ])('refuses the secret key "%s" — only TEST-mode secret keys are accepted', (secretKey) => {
      expect(() => loadConfig({ ...keys, STRIPE_SECRET_KEY: secretKey })).toThrow(/TEST-mode/);
    });

    it.each(['whsec_', 'abc', 'sk_test_abc123', 'whsec_a b'])(
      'refuses the webhook secret "%s"',
      (secret) => {
        expect(() => loadConfig({ ...keys, STRIPE_WEBHOOK_SECRET: secret })).toThrow(
          /webhook signing secret/,
        );
      },
    );

    it('never echoes a secret in an error message', () => {
      for (const env of [
        { ...keys, STRIPE_SECRET_KEY: 'sk_live_supersecretvalue' },
        { ...keys, STRIPE_WEBHOOK_SECRET: 'notasecret_supersecretvalue' },
      ]) {
        try {
          loadConfig(env);
          throw new Error('expected loadConfig to throw');
        } catch (error) {
          expect((error as Error).message).not.toContain('supersecretvalue');
        }
      }
    });
  });
});
