import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ApiRequestError, fetchAdminCheck } from '../api/client';
import { useAuth } from '../auth/context';

type Check = 'checking' | 'allowed' | 'forbidden' | 'unavailable';

const navLinkClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);

/**
 * Admin dashboard shell (PRD §11). Even though <RequireAdmin> already hid it from non-admins, it
 * asks the SERVER to confirm admin access and shows the result — so the UI never trusts its own role
 * value: if the database role changed, or the browser state was tampered with, the API's answer wins.
 *
 * The five PRD admin areas are nested routes rendered through <Outlet> below (see AppRoutes.tsx):
 * Reports (index), Users, Draws, Charities, Winners. Each page composes existing Phase 4/6/7 API
 * contracts rather than reimplementing their business rules.
 */
export function AdminPage() {
  const { getAccessToken } = useAuth();
  const [check, setCheck] = useState<Check>('checking');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getAccessToken();
      let result: Check = 'allowed';
      try {
        if (!token) throw new ApiRequestError(401, null);
        await fetchAdminCheck(token);
      } catch (error) {
        result =
          error instanceof ApiRequestError && (error.status === 401 || error.status === 403)
            ? 'forbidden'
            : 'unavailable';
      }
      if (!cancelled) setCheck(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  if (check === 'checking') return <p role="status">Checking permissions…</p>;
  if (check === 'forbidden')
    return <p role="alert">You do not have permission to view this page.</p>;
  if (check === 'unavailable')
    return <p role="alert">Could not verify your permissions. Please try again.</p>;

  return (
    <section>
      <h1>Administrator area</h1>
      <nav aria-label="Admin sections" className="admin-nav">
        <NavLink to="/admin" end className={navLinkClass}>
          Reports
        </NavLink>
        <NavLink to="/admin/users" className={navLinkClass}>
          Users
        </NavLink>
        <NavLink to="/admin/draws" className={navLinkClass}>
          Draws
        </NavLink>
        <NavLink to="/admin/charities" className={navLinkClass}>
          Charities
        </NavLink>
        <NavLink to="/admin/winners" className={navLinkClass}>
          Winners
        </NavLink>
      </nav>
      <Outlet />
    </section>
  );
}
