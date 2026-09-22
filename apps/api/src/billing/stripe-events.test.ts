import { describe, expect, it } from 'vitest';
import {
  CUSTOMER,
  PERIOD_1,
  PRICE_MONTH,
  SUB,
  at,
  checkoutSessionObject,
  invoiceObject,
  stripeEvent,
  subscriptionObject,
} from '../test-support/stripe.js';
import {
  InvalidStripeEventError,
  METADATA_KEYS,
  UnprocessableEventError,
  parseCheckoutSession,
  parseEnvelope,
  parseInvoice,
  parseMetadata,
  parseSubscription,
} from './stripe-events.js';

const CHARITY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

describe('parseEnvelope', () => {
  it('reads id, type, created, livemode and the object', () => {
    const env = parseEnvelope(
      stripeEvent(
        'invoice.paid',
        { id: 'in_1' },
        { id: 'evt_1', created: at('2026-09-01T00:00:00Z') },
      ),
    );
    expect(env).toMatchObject({
      id: 'evt_1',
      type: 'invoice.paid',
      livemode: false,
      object: { id: 'in_1' },
    });
    expect(env.created.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it.each([
    ['not an object', 'evt'],
    ['null', null],
    ['an array', []],
    ['no id', { type: 'x', created: 1, livemode: false, data: { object: {} } }],
    ['no type', { id: 'e', created: 1, livemode: false, data: { object: {} } }],
    [
      'a fractional created',
      { id: 'e', type: 'x', created: 1.5, livemode: false, data: { object: {} } },
    ],
    [
      'a negative created',
      { id: 'e', type: 'x', created: -1, livemode: false, data: { object: {} } },
    ],
    [
      'a string created',
      { id: 'e', type: 'x', created: '1', livemode: false, data: { object: {} } },
    ],
    [
      'a non-boolean livemode',
      { id: 'e', type: 'x', created: 1, livemode: 'false', data: { object: {} } },
    ],
    ['no data', { id: 'e', type: 'x', created: 1, livemode: false }],
    ['no data.object', { id: 'e', type: 'x', created: 1, livemode: false, data: {} }],
  ])('rejects %s', (_label, event) => {
    expect(() => parseEnvelope(event)).toThrow(InvalidStripeEventError);
  });
});

describe('parseMetadata — our checkout snapshot is read defensively', () => {
  it('reads all four keys', () => {
    expect(
      parseMetadata({
        [METADATA_KEYS.userId]: USER,
        [METADATA_KEYS.planId]: CHARITY,
        [METADATA_KEYS.charityId]: CHARITY,
        [METADATA_KEYS.charityBps]: '1500',
      }),
    ).toEqual({ userId: USER, planId: CHARITY, charityId: CHARITY, charityBps: 1500 });
  });

  it('treats absent, non-object and malformed values as absent — never trusted', () => {
    const none = { userId: null, planId: null, charityId: null, charityBps: null };
    for (const bad of [undefined, null, 'x', 5, [], {}]) expect(parseMetadata(bad)).toEqual(none);
    expect(
      parseMetadata({ [METADATA_KEYS.charityId]: 'not-a-uuid', [METADATA_KEYS.userId]: 5 }),
    ).toEqual(none);
  });

  it.each(['15.5', '-1', 'abc', '', '100000', '1e3', ' 1500'])(
    'ignores an unusable percentage "%s"',
    (bps) => {
      expect(parseMetadata({ [METADATA_KEYS.charityBps]: bps }).charityBps).toBeNull();
    },
  );
});

describe('parseSubscription', () => {
  it('reads the current API shape (period on the item)', () => {
    const sub = parseSubscription(
      subscriptionObject({
        metadata: { [METADATA_KEYS.userId]: USER },
        cancelAtPeriodEnd: true,
        canceledAt: at('2026-09-10T00:00:00Z'),
      }),
    );
    expect(sub).toMatchObject({
      id: SUB,
      customerId: CUSTOMER,
      status: 'active',
      priceId: PRICE_MONTH,
      cancelAtPeriodEnd: true,
    });
    expect(sub.periodStart?.toISOString()).toBe(new Date(PERIOD_1.start * 1000).toISOString());
    expect(sub.periodEnd?.toISOString()).toBe(new Date(PERIOD_1.end * 1000).toISOString());
    expect(sub.canceledAt?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(sub.metadata.userId).toBe(USER);
  });

  it('reads the older API shape (period on the subscription)', () => {
    const sub = parseSubscription(subscriptionObject({ legacyPeriod: true }));
    expect(sub.periodEnd?.toISOString()).toBe(new Date(PERIOD_1.end * 1000).toISOString());
  });

  it('accepts an expanded customer object', () => {
    const raw = { ...subscriptionObject(), customer: { id: 'cus_expanded', object: 'customer' } };
    expect(parseSubscription(raw).customerId).toBe('cus_expanded');
  });

  it('a subscription without a period (incomplete) parses with null dates', () => {
    const raw = subscriptionObject({ status: 'incomplete' });
    const item = (raw.items as { data: Record<string, unknown>[] }).data[0];
    delete item?.current_period_start;
    delete item?.current_period_end;
    expect(parseSubscription(raw)).toMatchObject({
      status: 'incomplete',
      periodStart: null,
      periodEnd: null,
    });
  });

  it('carries ended_at', () => {
    expect(
      parseSubscription(
        subscriptionObject({ status: 'canceled', endedAt: at('2026-10-01T00:00:00Z') }),
      ).endedAt?.toISOString(),
    ).toBe('2026-10-01T00:00:00.000Z');
  });

  it.each([0, 2])('rejects a subscription with %i items (we sell exactly one plan)', (items) => {
    expect(() => parseSubscription(subscriptionObject({ items }))).toThrow(/exactly one item/);
  });

  it.each([
    ['no id', { id: undefined }],
    ['no status', { status: undefined }],
    ['no customer', { customer: undefined }],
    ['a numeric customer', { customer: 5 }],
    ['no items', { items: undefined }],
    ['a fractional period end (on the subscription)', { current_period_end: 1.5 }],
  ])('rejects %s', (_label, patch) => {
    const raw = { ...subscriptionObject({ legacyPeriod: true }), ...patch };
    expect(() => parseSubscription(raw)).toThrow(InvalidStripeEventError);
  });

  it('rejects an item without a price id', () => {
    const raw = subscriptionObject();
    (raw.items as { data: Record<string, unknown>[] }).data[0] = { id: 'si_1', price: {} };
    expect(() => parseSubscription(raw)).toThrow(InvalidStripeEventError);
  });
});

describe('parseInvoice', () => {
  it('reads the current API shape (subscription under parent.subscription_details)', () => {
    const inv = parseInvoice(
      invoiceObject({
        amountPaid: 1234,
        metadata: { [METADATA_KEYS.charityId]: CHARITY, [METADATA_KEYS.charityBps]: '2000' },
      }),
    );
    expect(inv).toMatchObject({
      id: 'in_test_1',
      customerId: CUSTOMER,
      subscriptionId: SUB,
      currency: 'USD',
      amountPaid: 1234,
      amountDue: 1234,
      totalExcludingTax: 1234,
      billingReason: 'subscription_create',
      paymentIntentId: null,
    });
    expect(inv.metadata).toMatchObject({ charityId: CHARITY, charityBps: 2000 });
    expect(inv.total).toBe(1234); // the invoice total, including any tax
    expect(inv.paidAt?.toISOString()).toBe('2026-09-01T00:00:05.000Z');
    expect(inv.periodStart?.toISOString()).toBe(new Date(PERIOD_1.start * 1000).toISOString());
    expect(inv.periodEnd?.toISOString()).toBe(new Date(PERIOD_1.end * 1000).toISOString());
  });

  it('reads the older API shape (subscription and payment_intent on the invoice)', () => {
    const inv = parseInvoice(
      invoiceObject({ legacy: true, metadata: { [METADATA_KEYS.charityId]: CHARITY } }),
    );
    expect(inv).toMatchObject({ subscriptionId: SUB, paymentIntentId: 'pi_test_1' });
    expect(inv.metadata.charityId).toBe(CHARITY);
  });

  it('accepts an expanded subscription object', () => {
    const raw = { ...invoiceObject({ legacy: true }), subscription: { id: 'sub_expanded' } };
    expect(parseInvoice(raw).subscriptionId).toBe('sub_expanded');
  });

  it('an invoice with no subscription (a one-off) has subscriptionId null', () => {
    expect(parseInvoice(invoiceObject({ subscription: null })).subscriptionId).toBeNull();
    expect(
      parseInvoice(invoiceObject({ subscription: null, legacy: true })).subscriptionId,
    ).toBeNull();
  });

  it('upper-cases the currency', () => {
    expect(parseInvoice(invoiceObject({ currency: 'gbp' })).currency).toBe('GBP');
  });

  it('covers the whole paid period across several lines (earliest start, latest end)', () => {
    const raw = invoiceObject();
    (raw.lines as { data: unknown[] }).data = [
      { period: { start: at('2026-09-15T00:00:00Z'), end: at('2026-10-01T00:00:00Z') } },
      { period: { start: at('2026-09-01T00:00:00Z'), end: at('2026-09-15T00:00:00Z') } },
      { period: { start: at('2026-10-01T00:00:00Z'), end: at('2026-11-01T00:00:00Z') } },
      'garbage',
      { period: null },
    ];
    const inv = parseInvoice(raw);
    expect(inv.periodStart?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(inv.periodEnd?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('a missing total_excluding_tax is null; a reported one is read', () => {
    expect(parseInvoice(invoiceObject({ totalExcludingTax: null })).totalExcludingTax).toBeNull();
    expect(
      parseInvoice(invoiceObject({ amountPaid: 1200, totalExcludingTax: 1000 })).totalExcludingTax,
    ).toBe(1000);
  });

  it('paid_at may be null (an unpaid invoice)', () => {
    expect(parseInvoice(invoiceObject({ paidAt: null })).paidAt).toBeNull();
  });

  describe('money is integer minor units or it is rejected (D-003)', () => {
    it.each([1.5, -1, '1000', null, Number.NaN, Number.MAX_SAFE_INTEGER + 2, {}])(
      'amount_paid %s',
      (amount) => {
        expect(() => parseInvoice({ ...invoiceObject(), amount_paid: amount })).toThrow(
          InvalidStripeEventError,
        );
      },
    );
    it.each([1.5, -1, '5'])('amount_due %s', (amount) => {
      expect(() => parseInvoice({ ...invoiceObject(), amount_due: amount })).toThrow(
        InvalidStripeEventError,
      );
    });
    it.each([1.5, -1, '5'])('total_excluding_tax %s', (amount) => {
      expect(() => parseInvoice({ ...invoiceObject(), total_excluding_tax: amount })).toThrow(
        InvalidStripeEventError,
      );
    });
  });

  it.each([
    ['no id', { id: undefined }],
    ['no customer', { customer: undefined }],
    ['no currency', { currency: undefined }],
    ['a two-letter currency', { currency: 'us' }],
    ['a numeric currency', { currency: 840 }],
    ['no amount_paid', { amount_paid: undefined }],
    ['no amount_due', { amount_due: undefined }],
    ['no total', { total: undefined }],
    ['a fractional total', { total: 10.5 }],
    ['a negative total', { total: -1 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseInvoice({ ...invoiceObject(), ...patch })).toThrow(InvalidStripeEventError);
  });

  it('rejects a non-object', () => {
    for (const bad of [null, 'in_1', 5, []])
      expect(() => parseInvoice(bad)).toThrow(InvalidStripeEventError);
  });
});

describe('parseCheckoutSession', () => {
  it('reads the fields we use', () => {
    expect(parseCheckoutSession(checkoutSessionObject({ clientReferenceId: USER }))).toEqual({
      id: 'cs_test_1',
      mode: 'subscription',
      customerId: CUSTOMER,
      subscriptionId: SUB,
      clientReferenceId: USER,
    });
  });
  it('a payment-mode session has no subscription', () => {
    const s = parseCheckoutSession(checkoutSessionObject({ mode: 'payment', subscription: null }));
    expect(s).toMatchObject({ mode: 'payment', subscriptionId: null });
  });
  it('rejects a session without id or mode', () => {
    expect(() => parseCheckoutSession({ mode: 'subscription' })).toThrow(InvalidStripeEventError);
    expect(() => parseCheckoutSession({ id: 'cs_1' })).toThrow(InvalidStripeEventError);
  });
});

describe('the two error classes are distinct', () => {
  it('unreadable vs unappliable', () => {
    expect(new InvalidStripeEventError('x')).not.toBeInstanceOf(UnprocessableEventError);
    expect(new UnprocessableEventError('x')).not.toBeInstanceOf(InvalidStripeEventError);
  });
});
