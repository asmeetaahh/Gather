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

describe('Admin draw management (PRD §11 ADM-02/03/04) — reuses the existing Phase 6 engine', () => {
  it('lists draws and lets an admin simulate a draft draw', async () => {
    renderApp({
      path: '/admin/draws',
      session: 'token-admin',
      api: {
        adminDraws: [
          stubAdminDraw(1, { drawMonth: '2027-03-01', mode: 'random', status: 'draft' }),
        ],
      },
    });
    await heading('Draws');
    fireEvent.click(await screen.findByRole('button', { name: /2027-03-01/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate' }));
    await screen.findByText(/Winning numbers:/);
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
  });

  it('publishing requires confirmation, then the draw becomes permanent', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp({
      path: '/admin/draws',
      session: 'token-admin',
      api: {
        adminDraws: [
          stubAdminDraw(1, {
            status: 'simulated',
            currency: 'USD',
            prizePoolMinor: 9000,
            winningNumbers: [1, 2, 3, 4, 5],
          }),
        ],
      },
    });
    await heading('Draws');
    fireEvent.click(await screen.findByRole('button', { name: /2027-01-01/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(confirmSpy).toHaveBeenCalled();
    await screen.findByText('This draw is published and permanent.');
    confirmSpy.mockRestore();
  });

  it('cancelling the publish confirmation leaves the draw unpublished', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp({
      path: '/admin/draws',
      session: 'token-admin',
      api: {
        adminDraws: [stubAdminDraw(1, { status: 'simulated', winningNumbers: [1, 2, 3, 4, 5] })],
      },
    });
    await heading('Draws');
    fireEvent.click(await screen.findByRole('button', { name: /2027-01-01/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.queryByText('This draw is published and permanent.')).toBeNull();
    confirmSpy.mockRestore();
  });

  it('creates a new draw for a month that has none yet', async () => {
    renderApp({ path: '/admin/draws', session: 'token-admin', api: { adminDraws: [] } });
    await heading('Draws');
    expect(await screen.findByText('No draws yet.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2027-05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draw' }));

    await screen.findByText('Draw created.');
    expect(await screen.findByRole('button', { name: /2027-05-01/ })).toBeTruthy();
  });

  it('a non-admin never sees draw management (the page never gets that far)', async () => {
    renderApp({ path: '/admin/draws', session: 'token-bob', api: {} });
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have permission/);
    expect(screen.queryByRole('heading', { name: 'Draws' })).toBeNull();
  });
});
