import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './context';
import { safeRedirect } from './helpers';

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section role="status">
      <h1>{title}</h1>
      {children}
    </section>
  );
}

/**
 * UX guard for pages that need a signed-in user. NOT a security control: every protected API call is
 * independently verified by the server (DECISIONS D-005). This only decides what the browser shows.
 */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  switch (state.status) {
    case 'loading':
      return <Notice title="Loading…" />;
    case 'unconfigured':
      return (
        <Notice title="Sign-in is unavailable">
          <p>Authentication is not configured for this environment.</p>
        </Notice>
      );
    case 'error':
      return (
        <Notice title="Something went wrong">
          <p role="alert">{state.message}</p>
        </Notice>
      );
    case 'unauthenticated':
      // Remember where the visitor was going so login can send them back — including the query string, so
      // "Choose this charity" (/account/charity?charity=<id>) is not forgotten by signing in.
      return (
        <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
      );
    case 'authenticated':
      return <Outlet />;
  }
}

/** UX guard for administrator pages (nested inside RequireAuth). The API enforces this again on every call. */
export function RequireAdmin() {
  const { state } = useAuth();
  if (state.status === 'authenticated' && state.user.role === 'admin') return <Outlet />;
  return (
    <Notice title="Not authorised">
      <p role="alert">You do not have permission to view this page.</p>
    </Notice>
  );
}

/** Login/signup are pointless for someone already signed in: send them on. */
export function GuestOnly() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'authenticated') {
    const from = (location.state as { from?: unknown } | null)?.from;
    return <Navigate to={safeRedirect(from)} replace />;
  }
  return <Outlet />;
}
