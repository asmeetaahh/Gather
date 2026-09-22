import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  ADMIN,
  ALICE,
  charity,
  createFakeAuthClient,
  fakeSession,
  stubApi,
} from './test-support/fakes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USERS = { 'token-alice': ALICE, 'token-admin': ADMIN };
/** Signup needs a charity to choose (CHR-01): every signing-up test serves this one. */
const RIVERSIDE = charity(1, { slug: 'riverside', name: 'Riverside Youth Fund' });
const chooseCharity = async (name: string) => {
  const option = await screen.findByRole<HTMLOptionElement>('option', { name });
  fireEvent.change(screen.getByLabelText('Charity'), { target: { value: option.value } });
};

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

const heading = (name: string) => screen.findByRole('heading', { name });
const fill = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const submit = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const adminChecks = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((c) => c.path === '/api/admin/check');

describe('when Supabase is not configured', () => {
  it('shows a clear notice on protected pages instead of crashing or looping', async () => {
    stubApi();
    render(
      <MemoryRouter initialEntries={['/account']}>
        <App client={null} />
      </MemoryRouter>,
    );
    expect(await heading('Sign-in is unavailable')).toBeTruthy();
  });

  it('login reports that sign-in is unavailable', async () => {
    stubApi();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App client={null} />
      </MemoryRouter>,
    );
    fill('Email', 'a@b.co');
    fill('Password', 'pw');
    submit('Log in');
    expect((await screen.findByRole('alert')).textContent).toMatch(/not available/);
  });
});

describe('unauthenticated visitors', () => {
  it.each(['/account', '/admin'])('are redirected from %s to the login page', async (path) => {
    const { api } = renderApp({ path });
    expect(await heading('Log in')).toBeTruthy();
    expect(adminChecks(api)).toHaveLength(0);
  });

  it('can still see public pages', async () => {
    renderApp({ path: '/' });
    expect(await heading('GATHER')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign up' })).toBeTruthy();
  });

  it('get a not-found page for unknown routes', async () => {
    renderApp({ path: '/nope' });
    expect(await heading('Page not found')).toBeTruthy();
  });
});

describe('session restoration', () => {
  it('restores a stored session on load and shows the server-verified identity', async () => {
    const { api } = renderApp({ path: '/account', session: 'token-alice' });
    expect(await heading('Your account')).toBeTruthy();
    expect(screen.getByText('alice@example.test')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    // The role came from the API, which was called with the restored session's token.
    expect(api.calls.find((c) => c.path === '/api/me')?.token).toBe('token-alice');
  });

  it('discards a stored session the server rejects, and sends the user to log in', async () => {
    const { auth } = renderApp({ path: '/account', session: 'token-revoked' });
    expect(await heading('Log in')).toBeTruthy();
    await waitFor(() => {
      expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });
  });

  it('shows an error, not a login loop, when the API is unreachable', async () => {
    renderApp({ path: '/account', session: 'token-alice', api: { down: true } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the server/);
  });

  it('explains an account that has no profile', async () => {
    renderApp({ path: '/account', session: 'token-orphan', api: { noProfile: ['token-orphan'] } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not fully set up/);
  });
});

describe('admin pages: the UI hides them, the server decides', () => {
  it('a regular user is told they are not authorised and the server is not even asked', async () => {
    const { api } = renderApp({ path: '/admin', session: 'token-alice' });
    expect(await heading('Not authorised')).toBeTruthy();
    expect(adminChecks(api)).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('an administrator sees the admin area after the server confirms it', async () => {
    const { api } = renderApp({ path: '/admin', session: 'token-admin' });
    expect(await heading('Administrator area')).toBeTruthy();
    expect(adminChecks(api)[0]?.token).toBe('token-admin');
    expect(screen.getByRole('link', { name: 'Admin' })).toBeTruthy();
  });

  it('shows "no permission" when the server refuses, even though the UI thought the user was an admin', async () => {
    renderApp({ path: '/admin', session: 'token-admin', api: { adminCheck: () => 403 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have permission/);
    expect(screen.queryByRole('heading', { name: 'Administrator area' })).toBeNull();
  });

  it('does not show admin content when the permission check cannot be completed', async () => {
    renderApp({ path: '/admin', session: 'token-admin', api: { adminCheck: () => 503 } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not verify/);
    expect(screen.queryByRole('heading', { name: 'Administrator area' })).toBeNull();
  });
});

describe('logging in', () => {
  it('signs in and returns the user to the page they were trying to reach', async () => {
    const { auth, behaviour } = renderApp({ path: '/admin' });
    behaviour.signInToken = 'token-admin';
    expect(await heading('Log in')).toBeTruthy(); // redirected from /admin

    fill('Email', ' root@example.test ');
    fill('Password', 'correct horse');
    submit('Log in');

    expect(await heading('Administrator area')).toBeTruthy();
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'root@example.test',
      password: 'correct horse',
    });
  });

  it('shows a generic message for bad credentials and stays on the login page', async () => {
    const { behaviour } = renderApp({ path: '/login' });
    behaviour.signInError = {
      code: 'invalid_credentials',
      message: 'Invalid login credentials',
      status: 400,
    };
    fill('Email', 'a@b.co');
    fill('Password', 'wrong');
    submit('Log in');
    expect((await screen.findByRole('alert')).textContent).toBe('Incorrect email or password.');
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeTruthy();
  });

  it('validates locally before calling Supabase', async () => {
    const { auth } = renderApp({ path: '/login' });
    await heading('Log in');
    submit('Log in');
    expect((await screen.findByRole('alert')).textContent).toBe('Enter your email address.');
    fill('Email', 'not-an-email');
    submit('Log in');
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a valid email address.');
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('sends an already-signed-in user away from the login page', async () => {
    renderApp({ path: '/login', session: 'token-alice' });
    expect(await heading('Your account')).toBeTruthy();
  });

  it('ignores a malicious redirect target (open-redirect protection)', async () => {
    renderApp({
      path: { pathname: '/login', state: { from: '//evil.example/steal' } },
      session: 'token-alice',
    });
    expect(await heading('Your account')).toBeTruthy();
  });
});

describe('signing up', () => {
  it('tells the user to confirm their email when the project requires it (no session yet)', async () => {
    const { auth, behaviour } = renderApp({
      path: '/signup',
      api: { charities: [RIVERSIDE] },
    });
    behaviour.signUpSessionToken = null;
    await heading('Create your account');
    fill('Email', 'new@example.test');
    fill('Password', 'a-long-password');
    await chooseCharity('Riverside Youth Fund');
    submit('Sign up');

    expect((await screen.findByRole('status')).textContent).toMatch(/Check your email/);
    // The chosen charity travels in the signup data, so it survives the confirmation email (CHR-01).
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'new@example.test',
      password: 'a-long-password',
      options: { data: { selected_charity_id: RIVERSIDE.id } },
    });
  });

  it('signs the user straight in when the project does not require confirmation', async () => {
    const { behaviour } = renderApp({
      path: '/signup',
      api: {
        users: { ...USERS, 'token-new': { ...ALICE, email: 'new@example.test' } },
        charities: [RIVERSIDE],
      },
    });
    behaviour.signUpSessionToken = 'token-new';
    await heading('Create your account');
    fill('Email', 'new@example.test');
    fill('Password', 'a-long-password');
    await chooseCharity('Riverside Youth Fund');
    submit('Sign up');

    expect(await heading('Your account')).toBeTruthy();
    expect(screen.getByText('new@example.test')).toBeTruthy();
  });

  it('shows a friendly error when the email is already registered', async () => {
    const { behaviour } = renderApp({ path: '/signup', api: { charities: [RIVERSIDE] } });
    behaviour.signUpError = {
      code: 'user_already_exists',
      message: 'User already registered',
      status: 422,
    };
    await heading('Create your account');
    fill('Email', 'taken@example.test');
    fill('Password', 'a-long-password');
    await chooseCharity('Riverside Youth Fund');
    submit('Sign up');
    expect((await screen.findByRole('alert')).textContent).toMatch(/already exists/);
  });
});

describe('logging out', () => {
  it('ends the local session and protected pages become inaccessible again', async () => {
    const { auth } = renderApp({ path: '/account', session: 'token-alice' });
    await heading('Your account');

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await heading('Log in')).toBeTruthy(); // RequireAuth redirected to /login
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.queryByText('alice@example.test')).toBeNull();
  });
});
