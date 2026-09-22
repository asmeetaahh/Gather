import { useAuth } from '../auth/context';

/** Placeholder protected page: proves routing and identity work. The real dashboard is a later phase. */
export function AccountPage() {
  const { state, signOut } = useAuth();
  if (state.status !== 'authenticated') return null; // <RequireAuth> guarantees this; narrows the type.
  const { user } = state;

  return (
    <section>
      <h1>Your account</h1>
      <dl>
        <dt>Email</dt>
        <dd>{user.email ?? 'Not available'}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
      </dl>
      <button type="button" onClick={() => void signOut()}>
        Log out
      </button>
    </section>
  );
}
