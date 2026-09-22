import { describe, expect, it } from 'vitest';
import { FakeGateway, InMemoryBilling } from '../test-support/billing.js';
import type { ProviderPrice } from './gateway.js';
import { checkPlanCatalogue, hasErrors, runPreflight, type PriceLookup } from './preflight.js';
import type { PlanRecord } from './repository.js';
import { HANDLED_EVENT_TYPES } from './webhooks.js';

const plan = (over: Partial<PlanRecord> & Pick<PlanRecord, 'interval'>): PlanRecord => ({
  id: `plan-${over.interval}`,
  name: over.interval === 'month' ? 'Monthly' : 'Yearly',
  amountMinor: over.interval === 'month' ? 1000 : 10000,
  currency: 'USD',
  stripePriceId: `price_${over.interval}`,
  ...over,
});
const price = (interval: 'month' | 'year', over: Partial<ProviderPrice> = {}): ProviderPrice => ({
  id: `price_${interval}`,
  active: true,
  livemode: false,
  currency: 'USD',
  unitAmount: interval === 'month' ? 1000 : 10000,
  type: 'recurring',
  interval,
  intervalCount: 1,
  ...over,
});
const lookups = (...prices: ProviderPrice[]) =>
  new Map<string, PriceLookup>(prices.map((p) => [p.id, { price: p }]));
const MONTHLY = plan({ interval: 'month' });
const YEARLY = plan({ interval: 'year' });
const errors = (findings: ReturnType<typeof checkPlanCatalogue>) =>
  findings.filter((f) => f.level === 'error');

describe('checkPlanCatalogue — the plans table and Stripe must agree (prices are configuration, OWNER D-070)', () => {
  it('a correct catalogue has no errors', () => {
    const findings = checkPlanCatalogue([MONTHLY, YEARLY], lookups(price('month'), price('year')));
    expect(errors(findings)).toEqual([]);
    expect(
      findings
        .filter((f) => f.level === 'ok')
        .map((f) => f.check)
        .sort(),
    ).toEqual(['discount', 'plan:month', 'plan:year']);
  });

  it('assumes no price and no currency: whatever the two sides agree on is fine', () => {
    const eur = [
      plan({ interval: 'month', amountMinor: 799, currency: 'EUR' }),
      plan({ interval: 'year', amountMinor: 7500, currency: 'EUR' }),
    ];
    const findings = checkPlanCatalogue(
      eur,
      lookups(
        price('month', { currency: 'EUR', unitAmount: 799 }),
        price('year', { currency: 'EUR', unitAmount: 7500 }),
      ),
    );
    expect(errors(findings)).toEqual([]);
  });

  it('the currency comparison ignores case (Stripe reports lower case)', () => {
    const findings = checkPlanCatalogue(
      [MONTHLY, YEARLY],
      lookups(price('month', { currency: 'usd' }), price('year', { currency: 'usd' })),
    );
    expect(errors(findings)).toEqual([]);
  });

  it.each([
    [
      'a different amount (it would be shown at one price and billed at another)',
      { unitAmount: 1200 },
      /charges 1200 but the plan says 1000/,
    ],
    ['a different currency', { currency: 'EUR' }, /currency is EUR but the plan says USD/],
    ['an inactive Stripe price', { active: false }, /not active/],
    ['a LIVE-mode price', { livemode: true }, /LIVE-mode/],
    [
      'a one-time price',
      { type: 'one_time', interval: null, intervalCount: null },
      /not a recurring one/,
    ],
    ['the wrong billing interval', { interval: 'year' }, /bills every 1 year/],
    ['every 3 months', { intervalCount: 3 }, /every 3 month/],
    ['a price with no fixed amount', { unitAmount: null }, /charges null/],
  ] as const)('flags %s', (_label, patch, message) => {
    const findings = errors(
      checkPlanCatalogue([MONTHLY, YEARLY], lookups(price('month', patch), price('year'))),
    );
    expect(
      findings.some((f) => f.check === 'plan:month' && message.test(f.message)),
      JSON.stringify(findings),
    ).toBe(true);
  });

  it('flags a plan with no Stripe price id (it cannot be sold)', () => {
    const f = errors(
      checkPlanCatalogue([{ ...MONTHLY, stripePriceId: null }, YEARLY], lookups(price('year'))),
    );
    expect(f[0]).toMatchObject({
      check: 'plan:month',
      message: expect.stringContaining('no stripe_price_id') as string,
    });
  });

  it('flags a price Stripe cannot find', () => {
    const map = new Map<string, PriceLookup>([
      ['price_month', { error: 'not found' }],
      ['price_year', { price: price('year') }],
    ]);
    expect(errors(checkPlanCatalogue([MONTHLY, YEARLY], map))[0]?.message).toMatch(
      /could not be read/,
    );
  });

  it.each(['month', 'year'] as const)(
    'flags a missing %s plan (PRD SUB-01 needs both)',
    (missing) => {
      const present = missing === 'month' ? [YEARLY] : [MONTHLY];
      const findings = errors(checkPlanCatalogue(present, lookups(price('month'), price('year'))));
      expect(findings.some((f) => f.check === `plan:${missing}`)).toBe(true);
    },
  );

  it('flags a yearly plan that is not a discount (it will not be offered)', () => {
    const findings = errors(
      checkPlanCatalogue(
        [MONTHLY, plan({ interval: 'year', amountMinor: 12000 })],
        lookups(price('month'), price('year', { unitAmount: 12000 })),
      ),
    );
    expect(findings.map((f) => f.check)).toContain('discount');
  });

  it('flags a yearly plan in a different currency than the monthly one', () => {
    const findings = errors(
      checkPlanCatalogue(
        [MONTHLY, plan({ interval: 'year', currency: 'EUR', amountMinor: 5000 })],
        lookups(price('month'), price('year', { currency: 'EUR', unitAmount: 5000 })),
      ),
    );
    expect(findings.map((f) => f.check)).toContain('discount');
  });

  it('an empty catalogue is an error', () => {
    expect(errors(checkPlanCatalogue([], new Map()))).toHaveLength(2);
  });
});

describe('runPreflight — read-only', () => {
  const setup = () => {
    const billing = new InMemoryBilling();
    const gateway = new FakeGateway();
    billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: 'price_month' });
    billing.seedPlan({ interval: 'year', amountMinor: 10000, stripePriceId: 'price_year' });
    gateway.remotePrices.set('price_month', price('month'));
    gateway.remotePrices.set('price_year', price('year'));
    return { billing, gateway };
  };

  it('reports ready when the database and Stripe agree, and lists the webhook events to enable', async () => {
    const { billing, gateway } = setup();
    const findings = await runPreflight({ repository: billing, gateway });
    expect(hasErrors(findings)).toBe(false);
    const webhook = findings.find((f) => f.check === 'webhook');
    for (const type of HANDLED_EVENT_TYPES) expect(webhook?.message).toContain(type);
    expect(findings.find((f) => f.check === 'database')?.level).toBe('ok');
  });

  it('changes NOTHING: it only reads prices, and writes nothing to Stripe or the database', async () => {
    const { billing, gateway } = setup();
    await runPreflight({ repository: billing, gateway });
    expect(gateway.retrieved.sort()).toEqual(['price_month', 'price_year']);
    expect([gateway.customers, gateway.checkouts, gateway.portals].map((a) => a.length)).toEqual([
      0, 0, 0,
    ]);
    expect(billing.calls).toEqual({
      recordPayment: 0,
      applySubscription: 0,
      saveStripeCustomer: 0,
    });
    expect(billing.subscriptions).toHaveLength(0);
    expect(billing.ledger.size).toBe(0);
  });

  it('reports a Stripe price that does not match its plan', async () => {
    const { billing, gateway } = setup();
    gateway.remotePrices.set('price_month', price('month', { unitAmount: 999 }));
    const findings = await runPreflight({ repository: billing, gateway });
    expect(hasErrors(findings)).toBe(true);
    expect(findings.find((f) => f.level === 'error')?.message).toMatch(
      /charges 999 but the plan says 1000/,
    );
  });

  it('reports a price Stripe cannot find, without failing the whole run', async () => {
    const { billing, gateway } = setup();
    gateway.remotePrices.delete('price_year');
    const findings = await runPreflight({ repository: billing, gateway });
    expect(findings.filter((f) => f.level === 'error').map((f) => f.check)).toContain('plan:year');
    expect(findings.some((f) => f.check === 'plan:month' && f.level === 'ok')).toBe(true);
  });

  it('reports the billing SQL as missing when the database function is not there (migration not applied)', async () => {
    const { billing, gateway } = setup();
    billing.failNext('hasOpenSubscription');
    const findings = await runPreflight({ repository: billing, gateway });
    expect(findings.find((f) => f.check === 'database')).toMatchObject({
      level: 'error',
      message: expect.stringContaining('supabase db push') as string,
    });
  });

  it('reports plans it cannot read and stops', async () => {
    const { billing, gateway } = setup();
    billing.failNext('listActivePlans');
    const findings = await runPreflight({ repository: billing, gateway });
    expect(findings.some((f) => f.check === 'plans' && f.level === 'error')).toBe(true);
    expect(gateway.retrieved).toEqual([]);
  });

  it('never puts a secret in its output', async () => {
    const { billing, gateway } = setup();
    const text = JSON.stringify(await runPreflight({ repository: billing, gateway }));
    expect(text).not.toMatch(/sk_test_|sk_live_|whsec_|service_role/i);
  });
});
