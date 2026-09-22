import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  ADMIN,
  ALICE,
  BOB,
  createFakeAuthClient,
  fakeSession,
  stubApi,
  stubAdminDraw,
} from './test-support/fakes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USERS = { 'token-alice': ALICE, 'token-bob': BOB, 'token-admin': ADMIN };

function renderApp(options: {
  path: string | InitialEntry;
  session?: string | null;
  api?: Parameters<typeof stubApi>[0];
}) {
  const api = stubApi({ users: USERS, ...options.api });
  const fake = createFakeAuthClient(options.session ? fakeSession(options.session) : null);
  render(
    <MemoryRouter initialEntries={[options.path]}>
      <App client={fake.client} />
    </MemoryRouter>,
  );
  return { ...fake, api };
}

const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

describe('Admin reports (PRD §11 ADM-07)', () => {
  it('shows live, derived figures — never fabricated ones', async () => {
    renderApp({
      path: '/admin',
      session: 'token-admin',
      api: {
        subscriptions: {
          'token-alice': {
            id: 's1',
            status: 'active',
            planName: 'Monthly',
            interval: 'month',
            currentPeriodEnd: '2027-02-01T00:00:00Z',
            cancelAtPeriodEnd: false,
            endedAt: null,
          },
        },
        adminDraws: [
          stubAdminDraw(1, { status: 'published', currency: 'USD', prizePoolMinor: 5000 }),
          stubAdminDraw(2, { status: 'draft' }),
        ],
        charityContributions: [{ currency: 'USD', amountMinor: 1234 }],
      },
    });
    await heading('Reports');
    const usersHeading = await screen.findByRole('heading', { name: 'Users' });
    const usersCard = usersHeading.closest('article');
    expect(usersCard?.textContent).toMatch(/Total users3/);
    expect(usersCard?.textContent).toMatch(/Active subscribers1/);
    expect(await screen.findByText('$50.00')).toBeTruthy(); // prize pool, formatted via formatMinorUnits
    expect(await screen.findByText('$12.34')).toBeTruthy(); // charity contributions
  });

  it('shows an empty state honestly when nothing has happened yet', async () => {
    renderApp({ path: '/admin', session: 'token-admin', api: {} });
    await heading('Reports');
    expect(await screen.findByText('No published draws yet.')).toBeTruthy();
    expect(await screen.findByText('No contributions recorded yet.')).toBeTruthy();
  });

  it('a non-admin never sees reports (the page never gets that far)', async () => {
    renderApp({ path: '/admin', session: 'token-bob', api: {} });
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have permission/);
    expect(screen.queryByRole('heading', { name: 'Reports' })).toBeNull();
  });
});
