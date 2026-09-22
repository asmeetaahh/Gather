import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/context';

/** Minimal navigation. Links reflect the server-verified role, but are convenience only (D-005). */
export function Layout() {
  const { state } = useAuth();
  const user = state.status === 'authenticated' ? state.user : null;

  return (
    <div className="shell">
      <nav aria-label="Main">
        <Link to="/">GATHER</Link>
        <Link to="/charities">Charities</Link>
        {user ? (
          <>
            <Link to="/account">Account</Link>
            <Link to="/account/charity">My charity</Link>
            <Link to="/account/subscription">Subscription</Link>
            {user.role === 'admin' && <Link to="/admin">Admin</Link>}
          </>
        ) : (
          <>
            <Link to="/login">Log in</Link>
            <Link to="/signup">Sign up</Link>
          </>
        )}
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
