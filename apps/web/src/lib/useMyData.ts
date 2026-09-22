import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/context';

export type Load<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

/**
 * Fetches the signed-in user's own data with a token-scoped API call, exposing loading/error/ready
 * states and a `reload` function to call again after an action succeeds. Every dashboard section uses
 * this so each one loads and fails independently (one section's outage never blanks the others).
 *
 * `fetcher` must be a STABLE reference (a module-level function such as `fetchMySubscription`, never
 * an inline arrow function) — it is a `useEffect`/`useCallback` dependency, so a fresh function identity
 * on every render would refetch in a loop.
 */
export function useMyData<T>(
  fetcher: (accessToken: string) => Promise<T>,
  errorMessage = 'Could not load this. Please try again.',
): { load: Load<T>; reload: () => Promise<void> } {
  const { getAccessToken } = useAuth();
  const [load, setLoad] = useState<Load<T>>({ status: 'loading' });

  // Reusable for action handlers (add/edit/delete, …), which are user-triggered, not effect-triggered,
  // so an unconditional setState afterwards is fine there (see the mount effect below for the guarded
  // version this same shape needs when it runs as an effect).
  const reload = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      setLoad({ status: 'ready', data: await fetcher(token) });
    } catch {
      setLoad({ status: 'error', message: errorMessage });
    }
  }, [getAccessToken, fetcher, errorMessage]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        const data = await fetcher(token);
        if (!cancelled) setLoad({ status: 'ready', data });
      } catch {
        if (!cancelled) setLoad({ status: 'error', message: errorMessage });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, fetcher, errorMessage]);

  return { load, reload };
}
