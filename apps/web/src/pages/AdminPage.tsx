import { useCallback, useEffect, useState } from 'react';
import { formatMinorUnits, type WinnerDetailDto, type WinnerSummaryDto } from '@gather/shared';
import { ApiRequestError, fetchAdminCheck } from '../api/client';
import { fetchAdminWinner, fetchAllWinners, markWinnerPaid, reviewWinner } from '../api/winners';
import { useAuth } from '../auth/context';

type Check = 'checking' | 'allowed' | 'forbidden' | 'unavailable';

/**
 * Placeholder admin page. Even though <RequireAdmin> already hid it from non-admins, it asks the SERVER
 * to confirm admin access and shows the result — so the UI never trusts its own role value: if the
 * database role changed, or the browser state was tampered with, the API's answer wins.
 *
 * Below that: a MINIMAL winner-verification queue (PRD §11 ADM-06) — enough to exercise approve/reject
 * and mark-paid. The full admin dashboard (reports, user/charity/draw management) is Phase 9.
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
      <p>Full admin tools (reports, user/charity/draw management) arrive in a later phase.</p>
      <WinnersQueue />
    </section>
  );
}

function WinnersQueue() {
  const { getAccessToken } = useAuth();
  const [winners, setWinners] = useState<WinnerSummaryDto[] | 'loading' | 'error'>('loading');
  const [selected, setSelected] = useState<WinnerDetailDto | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reusable for action handlers (review, mark paid), which are user-triggered, not effect-triggered.
  const reload = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const { winners: list } = await fetchAllWinners(token);
      setWinners(list);
    } catch {
      setWinners('error');
    }
  }, [getAccessToken]);

  // The mount fetch guards against a superseded/unmounted update itself, rather than through `reload`.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getAccessToken();
      if (!token) return;
      try {
        const { winners: list } = await fetchAllWinners(token);
        if (!cancelled) setWinners(list);
      } catch {
        if (!cancelled) setWinners('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  const openWinner = useCallback(
    async (id: string) => {
      setActionError(null);
      setNote('');
      const token = await getAccessToken();
      if (!token) return;
      try {
        const { winner } = await fetchAdminWinner(token, id);
        setSelected(winner);
      } catch {
        setActionError('Could not load that winner.');
      }
    },
    [getAccessToken],
  );

  const decide = useCallback(
    async (id: string, decision: 'approved' | 'rejected') => {
      setActionError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const { winner } = await reviewWinner(token, id, note ? { decision, note } : { decision });
        setSelected(winner);
        await reload();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not record that decision.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, note, reload],
  );

  const payout = useCallback(
    async (id: string) => {
      setActionError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const { winner } = await markWinnerPaid(token, id);
        setSelected(winner);
        await reload();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not mark this payout paid.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, reload],
  );

  if (winners === 'loading') return <p role="status">Loading winners…</p>;
  if (winners === 'error') return <p role="alert">Could not load winners.</p>;

  return (
    <div>
      <h2>Winners</h2>
      {winners.length === 0 ? (
        <p>No winners yet.</p>
      ) : (
        <ul>
          {winners.map((w) => (
            <li key={w.id}>
              <button type="button" onClick={() => void openWinner(w.id)}>
                {w.drawMonth} — {String(w.matchCount)}-number match —{' '}
                {formatMinorUnits(w.prizeMinor, w.currency)} — {w.verificationStatus} /{' '}
                {w.payoutStatus}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div aria-label="Winner review">
          <h3>
            {selected.drawMonth} — {String(selected.matchCount)}-number match
          </h3>
          <p>
            Verification: {selected.verificationStatus} · Payout: {selected.payoutStatus}
          </p>
          {selected.proofs.length === 0 ? (
            <p>No proof uploaded yet.</p>
          ) : (
            <ul>
              {selected.proofs.map((p) => (
                <li key={p.id}>
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer">
                      View screenshot
                    </a>
                  ) : (
                    'Screenshot uploaded'
                  )}
                </li>
              ))}
            </ul>
          )}

          {actionError && <p role="alert">{actionError}</p>}

          {selected.verificationStatus === 'pending_review' && (
            <div>
              <label htmlFor="review-note">Note (optional)</label>
              <input id="review-note" value={note} onChange={(e) => setNote(e.target.value)} />
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(selected.id, 'approved')}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(selected.id, 'rejected')}
              >
                Reject
              </button>
            </div>
          )}

          {selected.verificationStatus === 'approved' && selected.payoutStatus === 'pending' && (
            <button type="button" disabled={busy} onClick={() => void payout(selected.id)}>
              Mark payout paid
            </button>
          )}
        </div>
      )}
    </div>
  );
}
