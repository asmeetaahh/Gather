import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ALICE, charity, createFakeAuthClient, fakeSession, stubApi } from './test-support/fakes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RIVERSIDE = charity(1, {
  slug: 'riverside',
  name: 'Riverside Youth Fund',
  description: 'Golf coaching for young people.',
  tags: ['youth', 'sport'],
  isFeatured: true,
  images: [{ id: 'img1', url: 'https://cdn.test/riverside.png', altText: 'Children on a fairway' }],
  upcomingEvents: [
    {
      id: 'ev1',
      title: 'Charity day',
      description: 'A day on the course.',
      location: 'Riverside GC',
      startsAt: '2026-10-01T09:00:00Z',
      endsAt: null,
    },
  ],
});
const OCEANS = charity(2, { slug: 'oceans', name: 'Clean Oceans', tags: ['environment'] });
const CLOSED = charity(3, { slug: 'closed', name: 'Closed Charity' });

type ApiOptions = NonNullable<Parameters<typeof stubApi>[0]>;

function renderApp(path: InitialEntry, options: { session?: string; api?: ApiOptions } = {}) {
  const api = stubApi({
    users: { 'token-alice': ALICE },
    charities: [RIVERSIDE, OCEANS],
    ...options.api,
  });
  const fake = createFakeAuthClient(options.session ? fakeSession(options.session) : null);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App client={fake.client} />
    </MemoryRouter>,
  );
  return { api, ...fake };
}

const fill = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const listNames = async () =>
  within(await screen.findByRole('list', { name: 'Charities' }))
    .getAllByRole('heading')
    .map((h) => h.textContent);

describe('charity directory (public)', () => {
  it('lists charities without signing in, with links to their profiles', async () => {
    renderApp('/charities');
    expect(await listNames()).toEqual(['Riverside Youth Fund', 'Clean Oceans']);
    expect(screen.getByRole('link', { name: 'Riverside Youth Fund' }).getAttribute('href')).toBe(
      '/charities/riverside',
    );
  });

  it('is reachable from the main navigation', async () => {
    renderApp('/');
    fireEvent.click(await screen.findByRole('link', { name: 'Charities' }));
    expect(await screen.findByRole('heading', { name: 'Charities', level: 1 })).toBeTruthy();
  });

  it('searches, filters by tag and by featured', async () => {
    const { api } = renderApp('/charities');
    await listNames();

    fill('Search charities', 'ocean');
    click('Search');
    await waitFor(() => expect(api.calls.at(-1)?.search).toContain('q=ocean'));
    expect(await screen.findByRole('link', { name: 'Clean Oceans' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Riverside Youth Fund' })).toBeNull();

    fill('Search charities', '');
    fill('Tag', ' Youth ');
    click('Search');
    await waitFor(() => expect(api.calls.at(-1)?.search).toContain('tag=youth'));
    expect(await screen.findByRole('link', { name: 'Riverside Youth Fund' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Clean Oceans' })).toBeNull();

    fill('Tag', '');
    fireEvent.click(screen.getByLabelText(/Featured only/));
    click('Search');
    await waitFor(() => expect(api.calls.at(-1)?.search).toContain('featured=true'));
    expect(await listNames()).toEqual(['Riverside Youth Fund']);
  });

  it('says so when nothing matches', async () => {
    renderApp('/charities');
    await listNames();
    fill('Search charities', 'zzzz');
    click('Search');
    expect((await screen.findByText('No charities match your search.')).getAttribute('role')).toBe(
      'status',
    );
  });

  it('shows a clear error, not a blank page, when the API fails', async () => {
    renderApp('/charities', { api: { charitiesFail: 500 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
  });

  it('pages with Next / Previous', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      charity(100 + i, { name: `Charity ${String(100 + i)}`, slug: `c-${String(100 + i)}` }),
    );
    const { api } = renderApp('/charities', { api: { charities: many } });
    expect((await listNames()).length).toBe(20);
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();

    click('Next');
    await waitFor(() => expect(api.calls.at(-1)?.search).toContain('offset=20'));
    await waitFor(async () => expect((await listNames()).length).toBe(5));
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    click('Previous');
    await waitFor(async () => expect((await listNames()).length).toBe(20));
  });
});

describe('charity profile (public)', () => {
  it('shows description, images with alt text and upcoming events', async () => {
    renderApp('/charities/riverside');
    expect(await screen.findByRole('heading', { name: 'Riverside Youth Fund' })).toBeTruthy();
    expect(screen.getByText('Golf coaching for young people.')).toBeTruthy();
    const img = screen.getByAltText('Children on a fairway');
    expect(img.getAttribute('src')).toBe('https://cdn.test/riverside.png');

    const events = within(screen.getByRole('list', { name: 'Upcoming events' }));
    expect(events.getByText('Charity day')).toBeTruthy();
    expect(events.getByText(/Riverside GC/)).toBeTruthy();
    expect(events.getByText('A day on the course.')).toBeTruthy();
  });

  it('says when there are no upcoming events', async () => {
    renderApp('/charities/oceans');
    expect(await screen.findByText('No upcoming events.')).toBeTruthy();
  });

  it('shows a not-found page for an unknown or unlisted charity', async () => {
    renderApp('/charities/closed', { api: { archived: [CLOSED] } });
    expect(await screen.findByRole('heading', { name: 'Charity not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse all charities' })).toBeTruthy();
  });

  it('shows an error when the API fails', async () => {
    renderApp('/charities/riverside', { api: { charitiesFail: 500 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
  });

  it('offers a visitor to choose the charity by signing up, carrying the choice into signup', async () => {
    renderApp('/charities/riverside');
    fireEvent.click(await screen.findByRole('link', { name: 'Choose this charity' }));
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    // Pre-selected from the profile the visitor came from (CHR-01).
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Charity').value).toBe(RIVERSIDE.id);
    });
  });

  it('a signed-in user is offered the account page instead, never signup', async () => {
    renderApp('/charities/riverside', { session: 'token-alice' });
    const link = await screen.findByRole('link', { name: 'Choose this charity' });
    expect(link.getAttribute('href')).toBe(`/account/charity?charity=${RIVERSIDE.id}`);
  });
});

describe('homepage spotlight', () => {
  it('shows featured charities only', async () => {
    renderApp('/');
    const spotlight = await screen.findByRole('list', { name: 'Featured charities' });
    expect(within(spotlight).getByRole('link', { name: 'Riverside Youth Fund' })).toBeTruthy();
    expect(within(spotlight).queryByRole('link', { name: 'Clean Oceans' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Charity spotlight' })).toBeTruthy();
  });

  it('shows nothing (and no error) when no charity is featured', async () => {
    const { api } = renderApp('/', { api: { charities: [OCEANS] } });
    expect(await screen.findByRole('heading', { name: 'GATHER' })).toBeTruthy();
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/charity-spotlight')).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: 'Charity spotlight' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not break the homepage when the spotlight cannot load', async () => {
    const { api } = renderApp('/', { api: { charitiesFail: 500 } });
    expect(await screen.findByRole('heading', { name: 'GATHER' })).toBeTruthy();
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/charity-spotlight')).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: 'Charity spotlight' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('choosing a charity at signup (CHR-01, D-065)', () => {
  const options = async () => (await screen.findAllByRole('option')).map((o) => o.textContent);
  const optionsLoaded = () => screen.findByRole('option', { name: 'Riverside Youth Fund' });
  const fillCredentials = () => {
    fill('Email', 'new@example.test');
    fill('Password', 'a-long-password');
  };

  it('asks for a charity and offers only LISTED charities', async () => {
    renderApp('/signup', { api: { archived: [CLOSED] } });
    await optionsLoaded();
    expect(await options()).toEqual([
      'Choose a charity to support',
      'Riverside Youth Fund',
      'Clean Oceans',
    ]);
    expect(screen.getByLabelText<HTMLSelectElement>('Charity').value).toBe('');
  });

  it('collects the charity when none was preselected, and sends it with the signup', async () => {
    const { auth } = renderApp('/signup');
    await optionsLoaded();
    fillCredentials();
    fill('Charity', OCEANS.id);
    click('Sign up');
    await waitFor(() => {
      expect(auth.signUp).toHaveBeenCalledTimes(1);
    });
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'new@example.test',
      password: 'a-long-password',
      options: { data: { selected_charity_id: OCEANS.id } },
    });
  });

  it('will not sign up without a charity: it says so and Supabase is never called', async () => {
    const { auth } = renderApp('/signup');
    await optionsLoaded();
    fillCredentials();
    click('Sign up');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Choose the charity you want to support.',
    );
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('checks the credentials first, then the charity', async () => {
    const { auth } = renderApp('/signup');
    await optionsLoaded();
    click('Sign up');
    expect((await screen.findByRole('alert')).textContent).not.toMatch(/charity/i);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('keeps a charity chosen before signing up (?charity=): pre-selected and sent', async () => {
    const { auth } = renderApp(`/signup?charity=${OCEANS.id}`);
    await optionsLoaded();
    expect(screen.getByLabelText<HTMLSelectElement>('Charity').value).toBe(OCEANS.id);
    fillCredentials();
    click('Sign up');
    await waitFor(() => {
      expect(auth.signUp).toHaveBeenCalledTimes(1);
    });
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'new@example.test',
      password: 'a-long-password',
      options: { data: { selected_charity_id: OCEANS.id } },
    });
  });

  it('the visitor can still change a pre-selected charity', async () => {
    const { auth } = renderApp(`/signup?charity=${OCEANS.id}`);
    await optionsLoaded();
    fill('Charity', RIVERSIDE.id);
    fillCredentials();
    click('Sign up');
    await waitFor(() => {
      expect(auth.signUp).toHaveBeenCalledTimes(1);
    });
    expect(auth.signUp.mock.calls[0]?.[0].options?.data).toEqual({
      selected_charity_id: RIVERSIDE.id,
    });
  });

  it.each([
    ['an archived charity', () => `?charity=${CLOSED.id}`],
    ['an unknown id', () => `?charity=${charity(99).id}`],
    ['not an id at all', () => '?charity=<script>alert(1)</script>'],
  ])('ignores a ?charity= that is %s: nothing is pre-selected', async (_label, query) => {
    renderApp(`/signup${query()}`, { api: { archived: [CLOSED] } });
    await optionsLoaded();
    expect(screen.getByLabelText<HTMLSelectElement>('Charity').value).toBe('');
  });

  it('cannot sign up when the charity list cannot be loaded (and says why)', async () => {
    const { auth } = renderApp('/signup', { api: { charitiesFail: 500 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/sign-up is unavailable/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign up' }).disabled).toBe(true);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('cannot sign up when no charity is listed at all', async () => {
    const { auth } = renderApp('/signup', { api: { charities: [] } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/no charities to choose from/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign up' }).disabled).toBe(true);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('a visitor with an account keeps the choice: Log in leads to /account/charity with it selected', async () => {
    renderApp(`/signup?charity=${OCEANS.id}`);
    await optionsLoaded();
    // The footer link (the navigation has its own "Log in" link, which carries no choice).
    const footer = screen.getByText(/Already have an account/);
    fireEvent.click(within(footer).getByRole('link', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
    fill('Email', 'alice@example.test');
    fill('Password', 'correct horse');
    click('Log in');
    expect(await screen.findByRole('heading', { name: 'Your charity' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Charity').value).toBe(OCEANS.id);
    });
  });

  it('"Log in" keeps the choice even when clicked before the charity list has loaded', async () => {
    renderApp(`/signup?charity=${OCEANS.id}`);
    // Straight away: the list request has not resolved yet, so nothing has been validated or pre-selected.
    fireEvent.click(
      within(screen.getByText(/Already have an account/)).getByRole('link', { name: 'Log in' }),
    );
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
    fill('Email', 'alice@example.test');
    fill('Password', 'correct horse');
    click('Log in');
    expect(await screen.findByRole('heading', { name: 'Your charity' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Charity').value).toBe(OCEANS.id);
    });
  });

  it('after signing up with a confirmation email, the confirmation notice still appears', async () => {
    renderApp('/signup');
    await optionsLoaded();
    fillCredentials();
    fill('Charity', RIVERSIDE.id);
    click('Sign up');
    expect((await screen.findByRole('status')).textContent).toMatch(/Check your email/);
  });
});

describe('my charity and contribution percentage (signed in)', () => {
  const selected = (label: string) => screen.getByLabelText<HTMLSelectElement>(label).value;

  it('is protected: visitors are sent to log in', async () => {
    renderApp('/account/charity');
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
  });

  it('keeps the chosen charity through sign-in ("Choose this charity" while signed out)', async () => {
    renderApp(`/account/charity?charity=${RIVERSIDE.id}`);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
    fill('Email', 'alice@example.test');
    fill('Password', 'correct horse');
    click('Log in');
    expect(await screen.findByRole('heading', { name: 'Your charity' })).toBeTruthy();
    await waitFor(() => {
      expect(selected('Charity')).toBe(RIVERSIDE.id);
    });
  });

  it('tells a user with no charity that one is required to subscribe', async () => {
    renderApp('/account/charity', { session: 'token-alice' });
    expect(await screen.findByText('Choose a charity: you need one to subscribe.')).toBeTruthy();
  });

  it('once a charity is chosen the requirement notice is gone', async () => {
    renderApp('/account/charity', {
      session: 'token-alice',
      api: { preferences: { 'token-alice': { charityId: OCEANS.id, percentageBps: 1500 } } },
    });
    await screen.findByRole('heading', { name: 'Your charity' });
    expect(screen.queryByText(/you need one to subscribe/)).toBeNull();
  });

  it('shows the stored charity and percentage, and the rules', async () => {
    renderApp('/account/charity', {
      session: 'token-alice',
      api: { preferences: { 'token-alice': { charityId: OCEANS.id, percentageBps: 1250 } } },
    });
    expect(await screen.findByRole('heading', { name: 'Your charity' })).toBeTruthy();
    expect(selected('Charity')).toBe(OCEANS.id);
    expect(screen.getByLabelText<HTMLInputElement>('Contribution percentage').value).toBe('12.5');
    expect(screen.getByText(/At least 10%/)).toBeTruthy();
    expect(screen.getByText(/raise or lower it at any time/)).toBeTruthy();
  });

  it('saves a new charity and percentage', async () => {
    const { api } = renderApp('/account/charity', { session: 'token-alice' });
    await screen.findByRole('heading', { name: 'Your charity' });
    fill('Charity', RIVERSIDE.id);
    fill('Contribution percentage', '15');
    click('Save');

    expect(await screen.findByText('Saved.')).toBeTruthy();
    const patch = api.calls.find((c) => c.method === 'PATCH');
    expect(patch?.token).toBe('token-alice');
    expect(patch?.body).toEqual({ percentageBps: 1500, charityId: RIVERSIDE.id });
    expect(api.stored.get('token-alice')).toEqual({ charityId: RIVERSIDE.id, percentageBps: 1500 });
  });

  it('only sends the percentage when the charity did not change', async () => {
    const { api } = renderApp('/account/charity', {
      session: 'token-alice',
      api: { preferences: { 'token-alice': { charityId: OCEANS.id, percentageBps: 2000 } } },
    });
    await screen.findByRole('heading', { name: 'Your charity' });
    fill('Contribution percentage', '25');
    click('Save');
    await screen.findByText('Saved.');
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ percentageBps: 2500 });
  });

  it('lets the user LOWER the percentage (down to 10%)', async () => {
    const { api } = renderApp('/account/charity', {
      session: 'token-alice',
      api: { preferences: { 'token-alice': { charityId: OCEANS.id, percentageBps: 5000 } } },
    });
    await screen.findByRole('heading', { name: 'Your charity' });
    fill('Contribution percentage', '10');
    click('Save');
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(api.stored.get('token-alice')?.percentageBps).toBe(1000);
  });

  it.each([
    ['5', /at least 10%/],
    ['9.99', /at least 10%/],
    ['0', /at least 10%/],
    ['abc', /such as 10 or 12\.5/],
    ['-10', /such as 10 or 12\.5/],
    ['12.345', /such as 10 or 12\.5/],
    ['', /such as 10 or 12\.5/],
    ['101', /cannot be more than 100%/],
  ])('rejects "%s" locally without calling the API', async (value, message) => {
    const { api } = renderApp('/account/charity', { session: 'token-alice' });
    await screen.findByRole('heading', { name: 'Your charity' });
    fill('Contribution percentage', value);
    click('Save');
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('applies a configured cap locally and shows it', async () => {
    const { api } = renderApp('/account/charity', {
      session: 'token-alice',
      api: { maxBps: 3000 },
    });
    await screen.findByRole('heading', { name: 'Your charity' });
    expect(screen.getByText(/at most 30%/)).toBeTruthy();
    fill('Contribution percentage', '31');
    click('Save');
    expect((await screen.findByRole('alert')).textContent).toMatch(/30%/);
    expect(api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it("shows the server's explanation when it refuses (the server is the authority)", async () => {
    renderApp('/account/charity', { session: 'token-alice', api: { charities: [RIVERSIDE] } });
    await screen.findByRole('heading', { name: 'Your charity' });
    fill('Charity', RIVERSIDE.id);
    // The charity is archived after the page loaded its list: the server now refuses it.
    stubApi({ users: { 'token-alice': ALICE }, charities: [], archived: [RIVERSIDE] });
    click('Save');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That charity is no longer available to select.',
    );
  });

  it('shows a generic message when saving fails without a usable server message', async () => {
    renderApp('/account/charity', { session: 'token-alice' });
    await screen.findByRole('heading', { name: 'Your charity' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    fill('Contribution percentage', '20');
    click('Save');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your changes could not be saved. Please try again.',
    );
  });

  it('flags a chosen charity that is no longer listed and asks for another', async () => {
    renderApp('/account/charity', {
      session: 'token-alice',
      api: {
        archived: [CLOSED],
        preferences: { 'token-alice': { charityId: CLOSED.id, percentageBps: 1500 } },
      },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Closed Charity is no longer listed\. Please choose another charity — you need a listed charity to subscribe/,
    );
    expect(selected('Charity')).toBe('');
    const options = within(screen.getByLabelText('Charity')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).not.toContain('Closed Charity');
  });

  it('preselects the charity chosen from its profile page (?charity=)', async () => {
    renderApp(`/account/charity?charity=${RIVERSIDE.id}`, { session: 'token-alice' });
    await screen.findByRole('heading', { name: 'Your charity' });
    expect(selected('Charity')).toBe(RIVERSIDE.id);
  });

  it('ignores a ?charity= value that is not a listed charity', async () => {
    renderApp(`/account/charity?charity=${CLOSED.id}`, {
      session: 'token-alice',
      api: { archived: [CLOSED] },
    });
    await screen.findByRole('heading', { name: 'Your charity' });
    expect(selected('Charity')).toBe('');
  });

  it('shows an error when the settings cannot be loaded', async () => {
    renderApp('/account/charity', { session: 'token-alice', api: { charitiesFail: 500 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
  });
});
