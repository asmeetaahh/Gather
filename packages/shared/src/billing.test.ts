import { describe, expect, it } from 'vitest';
import {
  BILLING_ERROR_CODES,
  computeCharityContribution,
  computeInvoiceContribution,
  formatMinorUnits,
  isYearlyDiscounted,
  parseCreateCheckoutRequest,
} from './billing.js';

describe('computeCharityContribution — D-025/D-069: percentage × basis, rounded UP, exact integers', () => {
  it.each([
    // basis, bps, expected
    [1000, 1000, 100], // exactly 10%
    [999, 1000, 100], // 99.9 → 100 (up)
    [1001, 1000, 101], // 100.1 → 101 (up)
    [1, 1000, 1], // never zero for a positive basis
    [9, 1000, 1],
    [10, 1000, 1],
    [11, 1000, 2],
    [1999, 1500, 300], // 299.85 → 300
    [1000, 1500, 150],
    [1000, 10000, 1000], // 100%
    [12345, 2575, 3179], // 25.75% of 123.45 = 31.788… → 3179 (minor units: 3178.8375 → 3179)
  ])('basis %i at %i bps → %i', (basis, bps, expected) => {
    expect(computeCharityContribution(basis, bps)).toBe(expected);
  });

  it('never gives the charity LESS than the chosen percentage', () => {
    for (let basis = 1; basis <= 500; basis += 7) {
      for (const bps of [1000, 1234, 2500, 3333, 9999, 10000]) {
        const amount = computeCharityContribution(basis, bps);
        expect(amount * 10000, `${String(basis)}@${String(bps)}`).toBeGreaterThanOrEqual(
          basis * bps,
        );
        // …and never more than one minor unit above it.
        expect((amount - 1) * 10000).toBeLessThan(basis * bps);
      }
    }
  });

  it('never exceeds the basis (the database enforces amount ≤ basis)', () => {
    for (const basis of [1, 2, 3, 99, 1000, 123456789]) {
      expect(computeCharityContribution(basis, 10000)).toBeLessThanOrEqual(basis);
    }
  });

  it('is exact for very large amounts (no floating-point drift)', () => {
    // 2^53 - 1 is the largest safe integer; a float multiply would lose precision long before this.
    expect(computeCharityContribution(Number.MAX_SAFE_INTEGER, 10000)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(computeCharityContribution(9_007_199_254_740_991, 1000)).toBe(900_719_925_474_100); // ceil(900719925474099.1)
    expect(computeCharityContribution(10_000_000_000_000, 1234)).toBe(1_234_000_000_000);
  });

  it('is exact where 0.1-style floats are not (0.1 + 0.2 territory)', () => {
    // 10% of 3 minor units: 0.3 in floats is 0.30000000000000004 → would round up to 1 either way; 10% of 30 is 3.
    expect(computeCharityContribution(30, 1000)).toBe(3);
    expect(computeCharityContribution(70, 1000)).toBe(7);
    expect(computeCharityContribution(290, 1000)).toBe(29);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'refuses the basis %s',
    (basis) => {
      expect(() => computeCharityContribution(basis, 1000)).toThrow(RangeError);
    },
  );

  it.each([0, 999, 10001, -1000, 1500.5, Number.NaN])(
    'refuses the percentage %s (below 10%%, above 100%%, fractional)',
    (bps) => {
      expect(() => computeCharityContribution(1000, bps)).toThrow(RangeError);
    },
  );
});

describe('isYearlyDiscounted (SUB-01: yearly is a discounted rate)', () => {
  const monthly = { amountMinor: 1000, currency: 'USD' };
  it('accepts a yearly price below twelve monthly payments', () => {
    expect(isYearlyDiscounted(monthly, { amountMinor: 10000, currency: 'USD' })).toBe(true);
    expect(isYearlyDiscounted(monthly, { amountMinor: 11999, currency: 'USD' })).toBe(true);
  });
  it('rejects a yearly price equal to or above twelve monthly payments', () => {
    expect(isYearlyDiscounted(monthly, { amountMinor: 12000, currency: 'USD' })).toBe(false);
    expect(isYearlyDiscounted(monthly, { amountMinor: 15000, currency: 'USD' })).toBe(false);
  });
  it('rejects prices in different currencies (they cannot be compared)', () => {
    expect(isYearlyDiscounted(monthly, { amountMinor: 100, currency: 'EUR' })).toBe(false);
  });
});

describe('formatMinorUnits — string arithmetic, no float division', () => {
  it('formats two-decimal currencies', () => {
    expect(formatMinorUnits(1250, 'USD', 'en-US')).toBe('$12.50');
    expect(formatMinorUnits(5, 'USD', 'en-US')).toBe('$0.05');
    expect(formatMinorUnits(0, 'USD', 'en-US')).toBe('$0.00');
    expect(formatMinorUnits(100000, 'GBP', 'en-GB')).toBe('£1,000.00');
  });
  it('honours the currency’s own number of decimals (yen has none)', () => {
    expect(formatMinorUnits(1500, 'JPY', 'en-US')).toBe('¥1,500');
  });
  it('is exact for amounts a float cannot hold', () => {
    expect(formatMinorUnits(9_007_199_254_740_991, 'USD', 'en-US')).toBe('$90,071,992,547,409.91');
  });
});

describe('parseCreateCheckoutRequest', () => {
  it.each(['month', 'year'] as const)('accepts %s', (interval) => {
    expect(parseCreateCheckoutRequest({ interval })).toEqual({ ok: true, value: { interval } });
  });
  it('ignores everything else (a userId, a price id, an amount)', () => {
    expect(
      parseCreateCheckoutRequest({
        interval: 'year',
        userId: 'x',
        priceId: 'price_1',
        amount: 1,
        charityId: 'c',
      }),
    ).toEqual({ ok: true, value: { interval: 'year' } });
  });
  it.each([
    {},
    { interval: 'week' },
    { interval: 'Month' },
    { interval: 1 },
    { interval: null },
    { interval: ['month'] },
  ])('rejects %j with a field error', (body) => {
    const r = parseCreateCheckoutRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe('interval');
  });
  it.each([null, undefined, 'month', 5, []])('rejects a non-object body %j', (body) => {
    const r = parseCreateCheckoutRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe('body');
  });
});

describe('BILLING_ERROR_CODES', () => {
  it('are stable and distinct', () => {
    expect(BILLING_ERROR_CODES).toEqual({
      alreadySubscribed: 'already_subscribed',
      planUnavailable: 'plan_unavailable',
      noBillingAccount: 'no_billing_account',
    });
  });
});

describe('computeInvoiceContribution — OWNER decision D-070: the amount collected, BEFORE tax, after coupons, gross of Stripe fees, rounded up', () => {
  const inv = (
    amountPaidMinor: number,
    totalMinor: number,
    totalExcludingTaxMinor: number | null,
    percentageBps = 1000,
  ) =>
    computeInvoiceContribution({
      amountPaidMinor,
      totalMinor,
      totalExcludingTaxMinor,
      percentageBps,
    });

  it('an invoice with no tax: the whole amount collected is the basis', () => {
    expect(inv(1000, 1000, 1000)).toEqual({ basisMinor: 1000, amountMinor: 100 });
    expect(inv(1000, 1000, null)).toEqual({ basisMinor: 1000, amountMinor: 100 });
  });

  it('a fully paid invoice WITH tax: the basis is exactly the pre-tax total', () => {
    expect(inv(1200, 1200, 1000)).toEqual({ basisMinor: 1000, amountMinor: 100 });
    expect(inv(1234, 1234, 1000, 2500)).toEqual({ basisMinor: 1000, amountMinor: 250 });
  });

  it('after a coupon: the fee actually collected (the coupon has already reduced amount paid, total and pre-tax total)', () => {
    expect(inv(800, 800, 800)).toEqual({ basisMinor: 800, amountMinor: 80 });
  });

  it('only PART paid, no tax (a credit balance covered the rest): the basis is what was collected', () => {
    expect(inv(600, 1000, 1000)).toEqual({ basisMinor: 600, amountMinor: 60 });
  });

  it('only PART paid WITH tax: the tax is taken out in proportion, so no tax is ever counted', () => {
    // total 1200 = 1000 + 200 tax; 600 collected → half of it is tax-free fee → 500 before tax.
    expect(inv(600, 1200, 1000)).toEqual({ basisMinor: 500, amountMinor: 50 });
  });

  it('is gross of Stripe fees: nothing is deducted for them', () => {
    // 3% + 30 of a 1000 charge is Stripe's; it is not an input and does not change the result.
    expect(inv(1000, 1000, 1000)).toEqual(inv(1000, 1000, 1000));
    expect(inv(1000, 1000, 1000).basisMinor).toBe(1000);
  });

  it('rounds the share UP to the smallest currency unit, with a single rounding', () => {
    expect(inv(999, 999, 999)).toEqual({ basisMinor: 999, amountMinor: 100 }); // 99.9 → 100
    expect(inv(1001, 1001, 1001)).toEqual({ basisMinor: 1001, amountMinor: 101 }); // 100.1 → 101
    expect(inv(1, 1, 1)).toEqual({ basisMinor: 1, amountMinor: 1 }); // never zero for something collected
    // exact rational: 601 × 1000 ÷ 1201 = 500.41… → basis 501; share = 601×1000×1000 ÷ (1201×10000) = 50.04… → 51
    expect(inv(601, 1201, 1000)).toEqual({ basisMinor: 501, amountMinor: 51 });
  });

  it('a single rounding is exact where rounding the basis first would overshoot', () => {
    // pre-tax basis 101 × 100 ÷ 1000 = 10.1 (recorded as 11); exact share at 95% = 9.595 → 10. Rounding the basis
    // first and then taking 95% of 11 would give 10.45 → 11: one unit too many.
    expect(
      computeInvoiceContribution({
        amountPaidMinor: 101,
        totalMinor: 1000,
        totalExcludingTaxMinor: 100,
        percentageBps: 9500,
      }),
    ).toEqual({
      basisMinor: 11,
      amountMinor: 10,
    });
  });

  it('never below the chosen percentage of the exact pre-tax amount, and never above the basis', () => {
    for (const [paid, total, excl] of [
      [1000, 1000, 1000],
      [777, 1200, 1000],
      [1, 3, 2],
      [99999, 120000, 100000],
      [5, 6, 5],
      [2, 1000, 999],
    ] as const) {
      for (const bps of [1000, 1234, 3333, 9999, 10000]) {
        const { basisMinor, amountMinor } = inv(paid, total, excl, bps);
        // exact share × 10⁴ × total ≤ amount × 10⁴ × total  (amount is the ceiling of the exact share)
        expect(BigInt(amountMinor) * 10000n * BigInt(total)).toBeGreaterThanOrEqual(
          BigInt(paid) * BigInt(excl) * BigInt(bps),
        );
        expect(BigInt(amountMinor - 1) * 10000n * BigInt(total)).toBeLessThan(
          BigInt(paid) * BigInt(excl) * BigInt(bps),
        );
        expect(amountMinor).toBeLessThanOrEqual(basisMinor);
        expect(basisMinor).toBeLessThanOrEqual(paid);
        expect(Number.isInteger(amountMinor) && Number.isInteger(basisMinor)).toBe(true);
      }
    }
  });

  it('is exact for very large amounts', () => {
    expect(
      inv(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 10000),
    ).toEqual({
      basisMinor: Number.MAX_SAFE_INTEGER,
      amountMinor: Number.MAX_SAFE_INTEGER,
    });
  });

  it('a total before tax ABOVE the total (nothing to remove) uses what was collected', () => {
    expect(inv(500, 500, 900)).toEqual({ basisMinor: 500, amountMinor: 50 });
  });

  it.each([
    ['nothing collected', 0, 1000, 1000, 1000],
    ['a fractional amount', 10.5, 1000, 1000, 1000],
    ['a negative total', 1000, -1, 1000, 1000],
    ['a fractional pre-tax total', 1000, 1000, 10.5, 1000],
    ['nothing before tax', 500, 1000, 0, 1000],
    ['a percentage below 10%', 1000, 1000, 1000, 999],
    ['a percentage above 100%', 1000, 1000, 1000, 10001],
    ['a fractional percentage', 1000, 1000, 1000, 1500.5],
  ])('refuses %s', (_label, paid, total, excl, bps) => {
    expect(() => inv(paid, total, excl, bps)).toThrow(RangeError);
  });
});
