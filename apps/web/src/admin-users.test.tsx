import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('Admin user management (PRD §11 ADM-01)', () => {
  it('lists every user, across owners, with triage information', async () => {
    renderApp({
      path: '/admin/users',
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
        scores: {
          'token-alice': [
            {
              id: 'sc1',
              playedOn: '2027-01-01',
              stablefordScore: 30,
              createdAt: 'x',
              updatedAt: 'x',
            },
          ],
        },
      },
    });
    await heading('Users');
    expect(await screen.findByText(/alice@example\.test/)).toBeTruthy();
    expect(await screen.findByText(/bob@example\.test/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')[0]?.textContent).toMatch(/— subscribed —/);
  });

  it('opens a user detail, edits the display name, and the change is saved server-side', async () => {
    renderApp({ path: '/admin/users', session: 'token-admin' });
    await heading('Users');
    fireEvent.click(await screen.findByRole('link', { name: /alice@example\.test/ }));
    await heading(/alice@example\.test/);

    const input = await screen.findByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'Alice A.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await screen.findByText('Saved.');
  });

  it('shows subscription as READ-ONLY — no admin action can set it manually', async () => {
    renderApp({
      path: '/admin/users',
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
      },
    });
    await heading('Users');
    fireEvent.click(await screen.findByRole('link', { name: /alice@example\.test/ }));
    await heading(/alice@example\.test/);
    expect(await screen.findByText(/Read-only: subscription state/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /set.*subscri/i })).toBeNull();
  });

  it('blocks a score write for a user without an active subscription, surfacing the server error', async () => {
    renderApp({ path: '/admin/users', session: 'token-admin' }); // bob: no subscription seeded
    await heading('Users');
    fireEvent.click(await screen.findByRole('link', { name: /bob@example\.test/ }));
    await heading(/bob@example\.test/);

    fireEvent.change(screen.getByLabelText('Date played'), { target: { value: '2027-01-05' } });
    fireEvent.change(screen.getByLabelText('Stableford score'), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add score' }));

    expect(await screen.findByText(/An active subscription is required/)).toBeTruthy();
  });

  it('deletes a score after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp({
      path: '/admin/users',
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
        scores: {
          'token-alice': [
            {
              id: 'sc1',
              playedOn: '2027-01-01',
              stablefordScore: 30,
              createdAt: 'x',
              updatedAt: 'x',
            },
          ],
        },
      },
    });
    await heading('Users');
    fireEvent.click(await screen.findByRole('link', { name: /alice@example\.test/ }));
    await heading(/alice@example\.test/);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(confirmSpy).toHaveBeenCalled();
    await screen.findByText('Deleted.');
    confirmSpy.mockRestore();
  });

  it('a non-admin never sees user management (the page never gets that far)', async () => {
    renderApp({ path: '/admin/users', session: 'token-bob' });
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have permission/);
    expect(screen.queryByRole('heading', { name: 'Users' })).toBeNull();
  });
});
