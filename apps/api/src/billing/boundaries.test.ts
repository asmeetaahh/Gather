import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Architecture guards for decisions that must not be undone by accident. They read the source, so a change that
 * breaks a decision fails here even if every behavioural test still passes.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url)); // repository root
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const isTest = (p: string) => /\.test\.tsx?$/.test(p) || /[/\\]test-support[/\\]/.test(p);
const production = (dir: string) => sources(join(ROOT, dir)).filter((p) => !isTest(p));
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Stripe is contained (D-067)', () => {
  it('only billing/gateway.ts imports the Stripe SDK', () => {
    const importers = production('apps/api/src')
      .filter((p) => /from\s+['"]stripe['"]/.test(readFileSync(p, 'utf8')))
      .map(rel);
    expect(importers).toEqual(['apps/api/src/billing/gateway.ts']);
  });

  it('the web app and the shared package never touch Stripe or its secrets', () => {
    for (const p of [...production('apps/web/src'), ...production('packages/shared/src')]) {
      const code = stripComments(readFileSync(p, 'utf8'));
      expect(code, rel(p)).not.toMatch(
        /from\s+['"]stripe['"]|STRIPE_SECRET|STRIPE_WEBHOOK_SECRET|sk_test_|whsec_/,
      );
    }
  });
});

describe('access never falls back to Stripe (OWNER decision D-070: fail closed when the recorded period ends)', () => {
  it('nothing that decides access imports the billing module or the Stripe SDK', () => {
    // Access is decided by the SQL function is_active_subscriber(), reached through auth/ and scores/. If either ever
    // imported billing/ or Stripe, an access decision could start calling Stripe as a fallback.
    for (const p of [
      ...production('apps/api/src/auth'),
      ...production('apps/api/src/scores'),
      ...production('apps/api/src/charities'),
    ]) {
      const code = stripComments(readFileSync(p, 'utf8'));
      expect(code, rel(p)).not.toMatch(/from\s+['"][^'"]*billing\/|from\s+['"]stripe['"]/);
    }
  });

  it('the entitlement lookup is the single SQL function, with no other rule', () => {
    const code = stripComments(
      readFileSync(join(ROOT, 'apps/api/src/auth/entitlement.ts'), 'utf8'),
    );
    expect(code).toContain("client.rpc('is_active_subscriber'");
    expect(code).not.toMatch(/current_period_end|provider_status|retrieve|fetch\(/);
  });
});

describe('prices and currency are configuration, never code (OWNER decision D-070)', () => {
  const CURRENCY_LITERAL = /['"`](USD|EUR|GBP|JPY|CAD|AUD|CHF|SEK|NOK|DKK|NZD|INR|CNY|XTS)['"`]/;
  const STRIPE_PRICE_ID = /['"`]price_[A-Za-z0-9]{4,}['"`]/;
  const dirs = ['apps/api/src', 'apps/web/src', 'packages/shared/src'];

  it.each(dirs)('%s has no hard-coded currency code or Stripe price id', (dir) => {
    for (const p of production(dir)) {
      const code = stripComments(readFileSync(p, 'utf8'));
      expect(code, `${rel(p)} hard-codes a currency`).not.toMatch(CURRENCY_LITERAL);
      expect(code, `${rel(p)} hard-codes a Stripe price id`).not.toMatch(STRIPE_PRICE_ID);
    }
  });

  it('the migrations create no plan rows (no price is decided in the schema)', () => {
    const migrations = join(ROOT, 'supabase/migrations');
    for (const name of readdirSync(migrations).filter((n) => n.endsWith('.sql'))) {
      const sql = stripSqlComments(readFileSync(join(migrations, name), 'utf8'));
      expect(sql, name).not.toMatch(/insert\s+into\s+public\.plans/i);
    }
  });

  it('the development seed creates no plan rows either', () => {
    expect(stripSqlComments(readFileSync(join(ROOT, 'supabase/seed.sql'), 'utf8'))).not.toMatch(
      /insert\s+into\s+public\.plans/i,
    );
  });
});

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}
