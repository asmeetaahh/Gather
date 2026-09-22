import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BILLING_ERROR_CODES,
  CHARITY_ERROR_CODES,
  type PlanDto,
  type SubscriptionDto,
} from '@gather/shared';
import { App } from './App';
import { goTo } from './lib/navigation';
import { ALICE, createFakeAuthClient, fakeSession, stubApi } from './test-support/fakes';

// A full-page navigation cannot happen in a test: capture where the app would send the browser.
vi.mock('./lib/navigation', () => ({ goTo: vi.fn() }));

beforeEach(() => {
  vi.mocked(goTo).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MONTHLY: PlanDto = {
  id: 'plan-m',
  name: 'Monthly',
  interval: 'month',
  amountMinor: 1000,
  currency: 'USD',
};
const YEARLY: PlanDto = {
  id: 'plan-y',
  name: 'Yearly',
  interval: 'year',
  amountMinor: 10000,
  currency: 'USD',
};

const sub = (over: Partial<SubscriptionDto> = {}): SubscriptionDto => ({
  id: 's1',
  status: 'active',
  planName: 'Monthly',
  interval: 'month',
  currentPeriodEnd: '2026-10-01T12:00:00.000Z',
  cancelAtPeriodEnd: false,
  endedAt: null,
  ...over,
});

type ApiOptions = NonNullable<Parameters<typeof stubApi>[0]>;
function renderApp(
  path: InitialEntry = '/account/subscription',
  options: { session?: string | null; api?: ApiOptions } = {},
) {
  const api = stubApi({
    users: { 'token-alice': ALICE },
    plans: [MONTHLY, YEARLY],
    ...options.api,
  });
  const session = options.session === undefined ? 'token-alice' : options.session;
  const fake = createFakeAuthClient(session ? fakeSession(session) : null);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App client={fake.client} />
    </MemoryRouter>,
  );
  return { api, ...fake };
}

const heading = (name: string, level?: number) =>
  screen.findByRole('heading', { name, ...(level && { level }) });
const click = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const posts = (api: ReturnType<typeof stubApi>, path: string) =>
  api.calls.filter((c) => c.method === 'POST' && c.path === path);

describe('the subscription page (SUB-01, SUB-04)', () => {
  it('is protected: a visitor is sent to log in', async () => {
    renderApp('/account/subscription', { session: null });
    expect(await heading('Log in')).toBeTruthy();
  });

  it('is reachable from the navigation when signed in', async () => {
    renderApp('/account');
    fireEvent.click(await screen.findByRole('link', { name: 'Subscription' }));
    expect(await heading('Subscription', 1)).toBeTruthy();
  });

  it('shows the monthly and the yearly plan with prices from integer minor units, and the yearly saving', async () => {
    renderApp();
    const plans = within(await screen.findByRole('list', { name: 'Plans' }));
    expect(plans.getByText('$10.00 per month')).toBeTruthy();
    expect(plans.getByText('$100.00 per year')).toBeTruthy();
    expect(plans.getByText('Saves $20.00 compared with 12 monthly payments.')).toBeTruthy();
    expect(plans.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Subscribe monthly',
      'Subscribe yearly',
    ]);
  });

  it('no yearly saving is claimed when there is nothing to compare', async () => {
    renderApp('/account/subscription', { api: { plans: [YEARLY] } });
    await screen.findByRole('list', { name: 'Plans' });
    expect(screen.queryByText(/Saves/)).toBeNull();
  });

  it('says so when no plan can be bought yet', async () => {
    renderApp('/account/subscription', { api: { plans: [] } });
    expect(await screen.findByText('No plans are available right now.')).toBeTruthy();
  });

  it('collects no card details — those are entered on Stripe’s own page', async () => {
    renderApp();
    await screen.findByRole('list', { name: 'Plans' });
    expect(document.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('shows an error, not a blank page, when it cannot load', async () => {
    renderApp('/account/subscription', { api: { billingFail: 500 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
  });
});

describe('starting Checkout', () => {
  it('sends the chosen interval (and nothing else) with the user’s token, then leaves for Stripe’s hosted page', async () => {
    const { api } = renderApp();
    await screen.findByRole('list', { name: 'Plans' });
    click('Subscribe yearly');
    await waitFor(() => {
      expect(goTo).toHaveBeenCalledWith('https://checkout.stripe.test/c/1');
    });
    const [call] = posts(api, '/api/me/subscription/checkout');
    expect(call?.token).toBe('token-alice');
    expect(call?.body).toEqual({ interval: 'year' });
  });

  it.each([
    [
      { status: 422, code: CHARITY_ERROR_CODES.selectionRequired },
      /Choose a charity before you subscribe/,
      true,
    ],
    [
      { status: 422, code: CHARITY_ERROR_CODES.selectedUnavailable },
      /no longer available.*Choose another charity/,
      true,
    ],
    [
      { status: 409, code: BILLING_ERROR_CODES.alreadySubscribed },
      /already have a subscription/,
      false,
    ],
    [{ status: 422, code: BILLING_ERROR_CODES.planUnavailable }, /not available right now/, false],
    [{ status: 503, code: 'service_unavailable' }, /Payments are not available/, false],
    [{ status: 502, code: 'payment_provider_error' }, /Something went wrong/, false],
    [{ status: 500 }, /Something went wrong/, false],
  ])(
    'the server refuses with %j: the user is told what to do, and is NOT sent to Stripe',
    async (checkoutError, message, offersCharity) => {
      renderApp('/account/subscription', { api: { checkoutError } });
      await screen.findByRole('list', { name: 'Plans' });
      click('Subscribe monthly');
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(message);
      expect(within(alert).queryAllByRole('link', { name: 'Choose a charity' })).toHaveLength(
        offersCharity ? 1 : 0,
      );
      expect(goTo).not.toHaveBeenCalled();
      // …and the buttons work again so the user can retry after fixing it.
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Subscribe monthly' }).disabled,
      ).toBe(false);
    },
  );

  it('the charity link leads to the page where it is fixed', async () => {
    renderApp('/account/subscription', {
      api: { checkoutError: { status: 422, code: CHARITY_ERROR_CODES.selectionRequired } },
    });
    await screen.findByRole('list', { name: 'Plans' });
    click('Subscribe monthly');
    fireEvent.click(await screen.findByRole('link', { name: 'Choose a charity' }));
    expect(await heading('Your charity')).toBeTruthy();
  });

  it('reminds the user their contribution goes to the charity they selected, with a way to change it', async () => {
    renderApp();
    await screen.findByRole('list', { name: 'Plans' });
    expect(screen.getByText(/goes to the charity you selected/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change it' }).getAttribute('href')).toBe(
      '/account/charity',
    );
  });

  it('a double click does not start two checkouts', async () => {
    const { api } = renderApp();
    await screen.findByRole('list', { name: 'Plans' });
    const button = screen.getByRole('button', { name: 'Subscribe monthly' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => {
      expect(goTo).toHaveBeenCalled();
    });
    expect(posts(api, '/api/me/subscription/checkout')).toHaveLength(1);
  });
});

describe('the subscription states (SUB-04: renewal, cancellation, lapsed; PRD §10 renewal date)', () => {
  const renewalDate = new Date('2026-10-01T12:00:00.000Z').toLocaleDateString();

  it('ACTIVE: plan, status and the renewal date — and no plans to buy', async () => {
    renderApp('/account/subscription', { api: { subscriptions: { 'token-alice': sub() } } });
    const current = within(await screen.findByLabelText('Current subscription'));
    expect(current.getByText(/Monthly \(monthly\)/)).toBeTruthy();
    expect(current.getByText('active')).toBeTruthy();
    expect(current.getByText(`Renews on ${renewalDate}`)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Plans' })).toBeNull();
  });

  it('CANCELLING at period end: says when it ends and that access continues until then', async () => {
    renderApp('/account/subscription', {
      api: { subscriptions: { 'token-alice': sub({ cancelAtPeriodEnd: true }) } },
    });
    expect(
      await screen.findByText(`Ends on ${renewalDate} — you keep access until then.`),
    ).toBeTruthy();
    expect(screen.queryByText(/Renews on/)).toBeNull();
  });

  it('PENDING: waiting for the first payment', async () => {
    renderApp('/account/subscription', {
      api: { subscriptions: { 'token-alice': sub({ status: 'pending', currentPeriodEnd: null }) } },
    });
    expect(await screen.findByText('Waiting for the first payment to be confirmed.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Plans' })).toBeNull();
  });

  it('LAPSED: tells the user their payment failed and offers billing management', async () => {
    renderApp('/account/subscription', {
      api: { subscriptions: { 'token-alice': sub({ status: 'lapsed' }) } },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /last payment did not go through/,
    );
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
  });

  it('CANCELLED: shows when it ended and offers the plans again', async () => {
    renderApp('/account/subscription', {
      api: {
        subscriptions: {
          'token-alice': sub({ status: 'cancelled', endedAt: '2026-09-15T00:00:00.000Z' }),
        },
      },
    });
    expect(
      await screen.findByText(
        `Ended on ${new Date('2026-09-15T00:00:00.000Z').toLocaleDateString()}.`,
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Plans' })).toBeTruthy();
  });
});

describe('the Billing Portal', () => {
  it('is offered once there is a Stripe customer, and leaves for Stripe’s portal', async () => {
    const { api } = renderApp('/account/subscription', {
      api: { subscriptions: { 'token-alice': sub() } },
    });
    await screen.findByLabelText('Current subscription');
    click('Manage billing');
    await waitFor(() => {
      expect(goTo).toHaveBeenCalledWith('https://billing.stripe.test/p/1');
    });
    expect(posts(api, '/api/me/subscription/portal')[0]?.token).toBe('token-alice');
  });

  it('is not offered before there is anything to manage', async () => {
    renderApp();
    await screen.findByRole('list', { name: 'Plans' });
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
  });
});

describe('returning from Checkout', () => {
  it('after paying: a confirmation is in progress, and the status can be refreshed', async () => {
    const { api } = renderApp('/account/subscription?checkout=success');
    expect((await screen.findByText(/Your payment is being confirmed/)).getAttribute('role')).toBe(
      'status',
    );
    const loads = () =>
      api.calls.filter((c) => c.path === '/api/me/subscription' && c.method === 'GET').length;
    expect(loads()).toBe(1);
    click('Refresh status');
    await waitFor(() => {
      expect(loads()).toBe(2);
    });
  });

  it('after cancelling: the user is told they were not charged', async () => {
    renderApp('/account/subscription?checkout=cancelled');
    expect(
      await screen.findByText('Checkout was cancelled. You have not been charged.'),
    ).toBeTruthy();
  });

  it('an unexpected ?checkout= value shows nothing special', async () => {
    renderApp('/account/subscription?checkout=<script>');
    await screen.findByRole('list', { name: 'Plans' });
    expect(screen.queryByText(/being confirmed|cancelled/)).toBeNull();
  });
});
