import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScoreDto } from '@gather/shared';
import { App } from './App';
import {
  ADMIN,
  ALICE,
  BOB,
  charity,
  createFakeAuthClient,
  fakeSession,
  stubApi,
  stubWinner,
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

const heading = (name: string | RegExp, level?: number) =>
  screen.findByRole('heading', { name, ...(level && { level }) });
const score = (playedOn: string, stablefordScore: number): ScoreDto => ({
  id: `id-${playedOn}`,
  playedOn,
  stablefordScore,
  createdAt: '2027-01-01T00:00:00Z',
  updatedAt: '2027-01-01T00:00:00Z',
});

describe('Dashboard — loading, empty and error states (PRD §10 DSH-01..05; item 6)', () => {
  it('shows a loading status while identity is confirmed, then the dashboard heading', async () => {
    renderApp({ path: '/account', session: 'token-alice' });
    expect(await heading('Your account', 1)).toBeTruthy();
  });

  it('shows an honest empty state for every section when the user has no data at all', async () => {
    renderApp({ path: '/account', session: 'token-alice' });
    await heading('Your account', 1);

    expect(await screen.findByText(/not subscribed yet/)).toBeTruthy();
    expect(await screen.findByText(/No charity selected yet/)).toBeTruthy();
    expect(
      await screen.findByText(/You have not been entered in a published draw yet/),
    ).toBeTruthy();
    expect(await screen.findByText('You have not won a draw yet.')).toBeTruthy();
    expect(await screen.findByText(/You have not entered any scores yet/)).toBeTruthy();
  });

  it("one section's failure does not blank the others — each loads independently", async () => {
    renderApp({ path: '/account', session: 'token-alice', api: { billingFail: 500 } });
    await heading('Your account', 1);

    // Subscription failed…
    const subscription = (await heading('Subscription', 2)).closest('article');
    expect(subscription).toBeTruthy();
    expect(within(subscription as HTMLElement).getByRole('alert').textContent).toMatch(
      /could not be loaded/,
    );
    // …but charity (an unrelated section) still rendered its real empty state.
    expect(await screen.findByText(/No charity selected yet/)).toBeTruthy();
  });
});

describe('Dashboard — subscription, charity, draws and winnings render real API data (item 9)', () => {
  it('renders a live subscription: status, plan and renewal date', async () => {
    renderApp({
      path: '/account',
      session: 'token-alice',
      api: {
        subscriptions: {
          'token-alice': {
            id: 'sub1',
            status: 'active',
            planName: 'Monthly',
            interval: 'month',
            currentPeriodEnd: '2027-06-15T00:00:00Z',
            cancelAtPeriodEnd: false,
            endedAt: null,
          },
        },
      },
    });
    await heading('Your account', 1);
    expect(await screen.findByText(/Monthly \(monthly\)/)).toBeTruthy();
    expect(await screen.findByText(/Renews on/)).toBeTruthy();
  });

  it('renders the caller’s real charity choice and percentage', async () => {
    const riverside = charity(1, { name: 'Riverside Youth Fund' });
    renderApp({
      path: '/account',
      session: 'token-alice',
      api: {
        charities: [riverside],
        preferences: { 'token-alice': { charityId: riverside.id, percentageBps: 1500 } },
      },
    });
    await heading('Your account', 1);
    expect(await screen.findByText(/Riverside Youth Fund — 15% of your subscription/)).toBeTruthy();
  });

  it('renders real draw participation with the match count', async () => {
    renderApp({
      path: '/account',
      session: 'token-alice',
      api: {
        draws: {
          'token-alice': [
            {
              drawId: 'd1',
              drawMonth: '2027-01-01',
              mode: 'random',
              winningNumbers: [1, 2, 3, 4, 5],
              matchCount: 4,
            },
          ],
        },
      },
    });
    await heading('Your account', 1);
    expect(await screen.findByText(/2027-01-01 — 4 of 5 matched \(random\)/)).toBeTruthy();
  });

  it('renders real winnings with prize amount and status', async () => {
    renderApp({
      path: '/account',
      session: 'token-alice',
      api: {
        winners: [
          stubWinner(1, {
            ownerToken: 'token-alice',
            matchCount: 3,
            prizeMinor: 2500,
            currency: 'USD',
            verificationStatus: 'approved',
            payoutStatus: 'pending',
          }),
        ],
      },
    });
    await heading('Your account', 1);
    expect(await screen.findByText(/\$25\.00 \(3-match\) — approved \/ pending/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View and manage proof' })).toBeTruthy();
  });
});

describe('Dashboard — cross-user isolation: a signed-in user never sees another user’s data', () => {
  it('Alice never sees Bob’s subscription, charity, scores, draws or winnings', async () => {
    const riverside = charity(1, { name: 'Riverside Youth Fund' });
    const oceanTrust = charity(2, { name: 'Ocean Trust' });
    renderApp({
      path: '/account',
      session: 'token-alice',
      api: {
        charities: [riverside, oceanTrust],
        preferences: {
          'token-alice': { charityId: riverside.id, percentageBps: 1000 },
          'token-bob': { charityId: oceanTrust.id, percentageBps: 5000 },
        },
        subscriptions: {
          'token-alice': null,
          'token-bob': {
            id: 'sub-bob',
            status: 'active',
            planName: 'Yearly',
            interval: 'year',
            currentPeriodEnd: '2028-01-01T00:00:00Z',
            cancelAtPeriodEnd: false,
            endedAt: null,
          },
        },
        scores: {
          'token-alice': [score('2027-01-01', 30)],
          'token-bob': [score('2027-02-02', 40)],
        },
        draws: {
          'token-bob': [
            {
              drawId: 'd1',
              drawMonth: '2027-01-01',
              mode: 'random',
              winningNumbers: [1, 2, 3, 4, 5],
              matchCount: 5,
            },
          ],
        },
        winners: [stubWinner(1, { ownerToken: 'token-bob', matchCount: 5 })],
      },
    });
    await heading('Your account', 1);

    // Alice's own (empty/none) states — never Bob's real data.
    expect(await screen.findByText(/not subscribed yet/)).toBeTruthy();
    expect(screen.queryByText(/Yearly \(yearly\)/)).toBeNull();
    expect(await screen.findByText(/Riverside Youth Fund/)).toBeTruthy();
    expect(screen.queryByText(/Ocean Trust/)).toBeNull();
    expect(await screen.findByText('2027-01-01: 30')).toBeTruthy();
    expect(screen.queryByText('2027-02-02: 40')).toBeNull();
    expect(
      await screen.findByText(/You have not been entered in a published draw yet/),
    ).toBeTruthy();
    expect(await screen.findByText('You have not won a draw yet.')).toBeTruthy();
  });
});

describe('Dashboard — score entry, edit and delete (PRD §05 DSH-02)', () => {
  it('adds a score and shows it in the list, newest first', async () => {
    const { api } = renderApp({ path: '/account', session: 'token-alice' });
    await heading('Your account', 1);

    fireEvent.change(screen.getByLabelText('Date played'), { target: { value: '2027-03-01' } });
    fireEvent.change(screen.getByLabelText('Stableford score'), { target: { value: '28' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add score' }));

    await screen.findByText('2027-03-01: 28');
    const posted = api.calls.find((c) => c.method === 'POST' && c.path === '/api/scores');
    expect(posted?.body).toEqual({ playedOn: '2027-03-01', stablefordScore: 28 });
  });

  it('rejects an out-of-range score client-side, before any request is sent', async () => {
    const { api } = renderApp({ path: '/account', session: 'token-alice' });
    await heading('Your account', 1);

    fireEvent.change(screen.getByLabelText('Date played'), { target: { value: '2027-03-01' } });
    fireEvent.change(screen.getByLabelText('Stableford score'), { target: { value: '46' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add score' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/scores')).toBe(false);
  });

  it('the server’s replace-oldest outcome is shown after a sixth score', async () => {
    renderApp({
      path: '/account',
      session: 'token-alice',
      api: {
        scores: {
          'token-alice': [
            score('2027-01-01', 20),
            score('2027-01-02', 21),
            score('2027-01-03', 22),
            score('2027-01-04', 23),
            score('2027-01-05', 24),
          ],
        },
      },
    });
    await heading('Your account', 1);
    await screen.findByText('2027-01-05: 24');

    fireEvent.change(screen.getByLabelText('Date played'), { target: { value: '2027-01-06' } });
    fireEvent.change(screen.getByLabelText('Stableford score'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add score' }));

    expect(await screen.findByText(/Replaced your oldest score \(2027-01-01\)/)).toBeTruthy();
    expect(screen.queryByText('2027-01-01: 20')).toBeNull();
    expect(await screen.findByText('2027-01-06: 25')).toBeTruthy();
  });

  it('edits an existing score in place', async () => {
    const { api } = renderApp({
      path: '/account',
      session: 'token-alice',
      api: { scores: { 'token-alice': [score('2027-01-01', 20)] } },
    });
    await heading('Your account', 1);
    await screen.findByText('2027-01-01: 20');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Score for 2027-01-01'), { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('2027-01-01: 33');
    const put = api.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/scores/2027-01-01');
    expect(put?.body).toEqual({ stablefordScore: 33 });
  });

  it('deletes a score after confirming', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const { api } = renderApp({
      path: '/account',
      session: 'token-alice',
      api: { scores: { 'token-alice': [score('2027-01-01', 20)] } },
    });
    await heading('Your account', 1);
    await screen.findByText('2027-01-01: 20');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('2027-01-01: 20')).toBeNull();
    });
    expect(
      api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/scores/2027-01-01'),
    ).toBe(true);
    expect(await screen.findByText(/You have not entered any scores yet/)).toBeTruthy();
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const { api } = renderApp({
      path: '/account',
      session: 'token-alice',
      api: { scores: { 'token-alice': [score('2027-01-01', 20)] } },
    });
    await heading('Your account', 1);
    await screen.findByText('2027-01-01: 20');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('2027-01-01: 20')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
