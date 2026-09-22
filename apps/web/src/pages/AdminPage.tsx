import { useEffect, useState } from 'react';
import { ApiRequestError, fetchAdminCheck } from '../api/client';
import { useAuth } from '../auth/context';

type Check = 'checking' | 'allowed' | 'forbidden' | 'unavailable';

/**
 * Placeholder admin page. Even though <RequireAdmin> already hid it from non-admins, it asks the SERVER
 * to confirm admin access and shows the result — so the UI never trusts its own role value: if the
 * database role changed, or the browser state was tampered with, the API's answer wins.
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
      <p>Admin tools will appear here in later phases.</p>
    </section>
  );
}
