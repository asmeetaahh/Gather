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

const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

describe('WinningsPage — a signed-in winner views and uploads their own proof (PRD §09/§10)', () => {
  it('lists only the caller’s own winnings, not another user’s', async () => {
    renderApp({
      path: '/account/winnings',
      session: 'token-alice',
      api: {
        winners: [
          stubWinner(1, { ownerToken: 'token-alice', matchCount: 5 }),
          stubWinner(2, { ownerToken: 'token-bob', matchCount: 3 }),
        ],
      },
    });
    await heading('Your winnings');
    expect(await screen.findByText(/5-number match/)).toBeTruthy();
    expect(screen.queryByText(/3-number match/)).toBeNull();
  });

  it('shows an upload form while awaiting proof, and uploads directly to storage then registers it', async () => {
    const { api, storage, uploadedObjects } = renderApp({
      path: '/account/winnings',
      session: 'token-alice',
      api: {
        winners: [
          stubWinner(1, { ownerToken: 'token-alice', verificationStatus: 'awaiting_proof' }),
        ],
      },
    });
    await heading('Your winnings');
    fireEvent.click(await screen.findByRole('button', { name: /3-number match/ }));
    const fileInput = await screen.findByLabelText<HTMLInputElement>(
      'Upload a screenshot of your scores',
    );
    const file = new File(['fake-bytes'], 'shot.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload proof' }));

    await screen.findByText('pending_review', { selector: 'dd' });
    expect(storage.from).toHaveBeenCalledWith('winner-proofs');
    expect(uploadedObjects.size).toBe(1);
    const registered = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/proof'));
    expect(registered).toBeTruthy();
  });

  it('a rejected winner can reopen and resubmit (D-021/D-037)', async () => {
    renderApp({
      path: '/account/winnings',
      session: 'token-alice',
      api: {
        winners: [
          stubWinner(1, {
            ownerToken: 'token-alice',
            verificationStatus: 'rejected',
            reviewNote: 'Blurry',
          }),
        ],
      },
    });
    await heading('Your winnings');
    fireEvent.click(await screen.findByRole('button', { name: /3-number match/ }));
    expect(await screen.findByText('Blurry')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByText(/Upload a screenshot of your scores/);
  });
});

describe('AdminPage winners queue — approve/reject and mark paid (PRD §11 ADM-06)', () => {
  it('lists winners across every user and lets an admin approve one', async () => {
    renderApp({
      path: '/admin/winners',
      session: 'token-admin',
      api: {
        winners: [
          stubWinner(1, {
            ownerToken: 'token-alice',
            verificationStatus: 'pending_review',
            proofs: [
              {
                id: 'p1',
                storagePath: '1/shot.png',
                uploadedAt: '2027-01-02T00:00:00Z',
                url: 'https://signed.test/1/shot.png',
              },
            ],
          }),
        ],
      },
    });
    await heading('Administrator area');
    fireEvent.click(await screen.findByRole('button', { name: /3-number match/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText(/Verification: approved/);
    expect(await screen.findByRole('button', { name: 'Mark payout paid' })).toBeTruthy();
  });

  it('marks an approved winner’s payout paid', async () => {
    renderApp({
      path: '/admin/winners',
      session: 'token-admin',
      api: {
        winners: [stubWinner(1, { ownerToken: 'token-alice', verificationStatus: 'approved' })],
      },
    });
    await heading('Administrator area');
    fireEvent.click(await screen.findByRole('button', { name: /3-number match/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark payout paid' }));
    await screen.findByText(/Payout: paid/);
  });

  it('a non-admin never sees the winners queue (the page never gets that far)', async () => {
    renderApp({ path: '/admin/winners', session: 'token-bob', api: { winners: [] } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have permission/);
    expect(screen.queryByRole('heading', { name: 'Winners' })).toBeNull();
  });
});
