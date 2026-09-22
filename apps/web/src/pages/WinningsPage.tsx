import { useCallback, useEffect, useState } from 'react';
import { formatMinorUnits, type WinnerDetailDto, type WinnerSummaryDto } from '@gather/shared';
import {
  fetchMyWinner,
  fetchMyWinners,
  registerWinnerProof,
  reopenWinnerProof,
  uploadWinnerProofFile,
} from '../api/winners';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/context';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; winners: WinnerSummaryDto[] };

/**
 * Minimal winnings view (PRD §09/§10 DSH-05, ROL-03 "upload winner proof"). Not the full dashboard
 * (Phase 8) — just enough to exercise view / upload / reopen for a signed-in winner. A screenshot is
 * uploaded DIRECTLY to private storage (ARCHITECTURE.md §10); this page never sees the file bytes
 * after that.
 */
export function WinningsPage() {
  const { getAccessToken, getStorage } = useAuth();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selected, setSelected] = useState<WinnerDetailDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reusable for action handlers (upload, reopen), which are user-triggered, not effect-triggered,
  // so an unconditional setState afterwards is fine there.
  const reload = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setLoad({ status: 'error', message: 'Sign in to see your winnings.' });
      return;
    }
    try {
      const { winners } = await fetchMyWinners(token);
      setLoad({ status: 'ready', winners });
    } catch {
      setLoad({ status: 'error', message: 'Could not load your winnings. Please try again.' });
    }
  }, [getAccessToken]);

  // The mount fetch guards against a superseded/unmounted update itself, rather than through `reload`.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getAccessToken();
      if (!token) {
        if (!cancelled) setLoad({ status: 'error', message: 'Sign in to see your winnings.' });
        return;
      }
      try {
        const { winners } = await fetchMyWinners(token);
        if (!cancelled) setLoad({ status: 'ready', winners });
      } catch {
        if (!cancelled) {
          setLoad({ status: 'error', message: 'Could not load your winnings. Please try again.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  const openWinner = useCallback(
    async (id: string) => {
      setDetailError(null);
      setActionError(null);
      const token = await getAccessToken();
      if (!token) return;
      try {
        const { winner } = await fetchMyWinner(token, id);
        setSelected(winner);
      } catch {
        setDetailError('Could not load that winner.');
      }
    },
    [getAccessToken],
  );

  const handleUpload = useCallback(
    async (winnerId: string, file: File) => {
      setActionError(null);
      setBusy(true);
      try {
        const storage = getStorage();
        const token = await getAccessToken();
        if (!storage || !token) {
          setActionError('Uploading is not available right now.');
          return;
        }
        const uploaded = await uploadWinnerProofFile(storage, winnerId, file);
        if (!uploaded.ok) {
          setActionError(uploaded.message);
          return;
        }
        const { winner } = await registerWinnerProof(token, winnerId, {
          storagePath: uploaded.storagePath,
        });
        setSelected(winner);
        await reload();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not upload your proof. Please try again.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, getStorage, reload],
  );

  const handleReopen = useCallback(
    async (winnerId: string) => {
      setActionError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const { winner } = await reopenWinnerProof(token, winnerId);
        setSelected(winner);
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not reopen this winner for resubmission.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken],
  );

  if (load.status === 'loading') return <p role="status">Loading your winnings…</p>;
  if (load.status === 'error') return <p role="alert">{load.message}</p>;

  return (
    <section>
      <h1>Your winnings</h1>
      {load.winners.length === 0 ? (
        <p>You have not won a draw yet.</p>
      ) : (
        <ul>
          {load.winners.map((w) => (
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

      {detailError && <p role="alert">{detailError}</p>}

      {selected && (
        <div aria-label="Winner detail">
          <h2>
            {selected.drawMonth} — {String(selected.matchCount)}-number match
          </h2>
          <dl>
            <dt>Prize</dt>
            <dd>{formatMinorUnits(selected.prizeMinor, selected.currency)}</dd>
            <dt>Verification</dt>
            <dd>{selected.verificationStatus}</dd>
            <dt>Payout</dt>
            <dd>{selected.payoutStatus}</dd>
            {selected.reviewNote && (
              <>
                <dt>Reviewer note</dt>
                <dd>{selected.reviewNote}</dd>
              </>
            )}
          </dl>

          <h3>Proof</h3>
          {selected.proofs.length === 0 ? (
            <p>No proof uploaded yet.</p>
          ) : (
            <ul>
              {selected.proofs.map((p) => (
                <li key={p.id}>
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer">
                      View uploaded screenshot
                    </a>
                  ) : (
                    'Screenshot uploaded'
                  )}{' '}
                  ({new Date(p.uploadedAt).toLocaleString()})
                </li>
              ))}
            </ul>
          )}

          {actionError && <p role="alert">{actionError}</p>}

          {selected.verificationStatus === 'awaiting_proof' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const input = event.currentTarget.elements.namedItem(
                  'proof',
                ) as HTMLInputElement | null;
                const file = input?.files?.[0];
                if (file) void handleUpload(selected.id, file);
              }}
            >
              <label htmlFor="proof">Upload a screenshot of your scores</label>
              <input id="proof" name="proof" type="file" accept="image/png,image/jpeg,image/webp" />
              <button type="submit" disabled={busy}>
                {busy ? 'Uploading…' : 'Upload proof'}
              </button>
            </form>
          )}

          {selected.verificationStatus === 'rejected' && (
            <button type="button" disabled={busy} onClick={() => void handleReopen(selected.id)}>
              {busy ? 'Please wait…' : 'Try again — upload a new screenshot'}
            </button>
          )}

          {selected.verificationStatus === 'pending_review' && (
            <p>Your proof is awaiting admin review.</p>
          )}
        </div>
      )}
    </section>
  );
}
