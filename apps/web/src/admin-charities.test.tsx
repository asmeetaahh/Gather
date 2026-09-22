import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  ADMIN,
  ALICE,
  BOB,
  charity,
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

describe('Admin charity management (PRD §11 ADM-05)', () => {
  it('lists charities, including archived ones the public directory never shows', async () => {
    renderApp({
      path: '/admin/charities',
      session: 'token-admin',
      api: { charities: [charity(1)], archived: [charity(2, { name: 'Old Cause' })] },
    });
    await heading('Charities');
    expect(await screen.findByText(/Charity 1/)).toBeTruthy();
    const oldCause = await screen.findByText('Old Cause');
    expect(oldCause.closest('li')?.textContent).toMatch(/archived/);
  });

  it('creates a new charity', async () => {
    renderApp({ path: '/admin/charities', session: 'token-admin', api: { charities: [] } });
    await heading('Charities');
    expect(await screen.findByText('No charities yet.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-cause' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Cause' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Helping people.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add charity' }));

    await screen.findByText('Charity created.');
    expect(await screen.findByText(/New Cause/)).toBeTruthy();
  });

  it('edits a charity', async () => {
    renderApp({
      path: '/admin/charities',
      session: 'token-admin',
      api: { charities: [charity(1)] },
    });
    await heading('Charities');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const editForm = within(await screen.findByRole('form', { name: 'Edit Charity 1' }));
    fireEvent.change(editForm.getByLabelText('Name'), { target: { value: 'Renamed Charity' } });
    fireEvent.click(editForm.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(await screen.findByText(/Renamed Charity/)).toBeTruthy();
  });

  it('archiving requires confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp({
      path: '/admin/charities',
      session: 'token-admin',
      api: { charities: [charity(1)] },
    });
    await heading('Charities');
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Unarchive' })).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it('a non-admin never sees charity management (the page never gets that far)', async () => {
    renderApp({ path: '/admin/charities', session: 'token-bob', api: {} });
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have permission/);
    expect(screen.queryByRole('heading', { name: 'Charities' })).toBeNull();
  });
});
