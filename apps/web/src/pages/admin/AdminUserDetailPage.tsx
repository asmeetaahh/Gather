import { useCallback, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  formatMinorUnits,
  formatPercent,
  playedOnError,
  stablefordScoreError,
  type AdminUserDetailDto,
} from '@gather/shared';
import {
  addAdminUserScore,
  deleteAdminUserScore,
  fetchAdminUser,
  updateAdminUserDisplayName,
  updateAdminUserScore,
} from '../../api/admin';
import { ApiRequestError } from '../../api/client';
import { useAuth } from '../../auth/context';
import { useMyData } from '../../lib/useMyData';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * One user's admin detail view (PRD §11 ADM-01: "view/edit user profiles; edit golf scores; manage
 * subscriptions"). Deliberately narrow, matching exactly what the API authorizes server-side:
 * - Profile editing is limited to display name — role changes stay a service-role/SQL-only operation
 *   (D-059); charity and percentage are the user's own financial choice, never overridden here.
 * - Score edits reuse the EXACT SAME `ScoreService` rules as the user's own `/api/scores` (an active
 *   subscription is still required to write) — no admin bypass exists server-side, so none is implied
 *   here either; a blocked write surfaces the server's own message.
 * - Subscription is shown READ-ONLY: subscription state is driven only by verified Stripe webhooks
 *   (D-068/D-070) — there is no "manually set subscription status" action.
 */
export function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const fetcher = useCallback((token: string) => fetchAdminUser(token, id ?? ''), [id]);
  const { load, reload } = useMyData(fetcher, 'This user could not be loaded.');

  if (!id) return <p role="alert">No user specified.</p>;
  if (load.status === 'loading') return <p role="status">Loading user…</p>;
  if (load.status === 'error') return <p role="alert">{load.message}</p>;

  return <UserDetail user={load.data.user} onChange={reload} />;
}

function UserDetail({
  user,
  onChange,
}: {
  user: AdminUserDetailDto;
  onChange: () => Promise<void>;
}) {
  return (
    <section aria-labelledby="admin-user-heading">
      <p>
        <Link to="/admin/users">&larr; Back to users</Link>
      </p>
      <h2 id="admin-user-heading">{user.displayName ?? user.email ?? user.id}</h2>

      <div className="dashboard-grid">
        <ProfileCard user={user} onChange={onChange} />
        <SubscriptionCard user={user} />
        <CharityCard user={user} />
        <WinnersCard user={user} />
      </div>

      <ScoresCard user={user} onChange={onChange} />
    </section>
  );
}

function ProfileCard({
  user,
  onChange,
}: {
  user: AdminUserDetailDto;
  onChange: () => Promise<void>;
}) {
  const { getAccessToken } = useAuth();
  const [name, setName] = useState(user.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        await updateAdminUserDisplayName(token, user.id, { displayName: name });
        setNotice('Saved.');
        await onChange();
      } catch (err) {
        setError(
          err instanceof ApiRequestError && err.serverMessage
            ? err.serverMessage
            : 'Could not save that change.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, name, onChange, user.id],
  );

  return (
    <article aria-labelledby="admin-user-profile-heading">
      <h3 id="admin-user-profile-heading">Profile</h3>
      <dl>
        <dt>Email</dt>
        <dd>{user.email ?? 'Not available'}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Joined</dt>
        <dd>{formatDate(user.createdAt)}</dd>
      </dl>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label>
          Display name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            maxLength={200}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
      </form>
    </article>
  );
}

function SubscriptionCard({ user }: { user: AdminUserDetailDto }) {
  return (
    <article aria-labelledby="admin-user-subscription-heading">
      <h3 id="admin-user-subscription-heading">Subscription</h3>
      {user.subscription ? (
        <dl>
          <dt>Status</dt>
          <dd>{user.subscription.status}</dd>
          <dt>Plan</dt>
          <dd>{user.subscription.planName}</dd>
          <dt>Current period ends</dt>
          <dd>
            {user.subscription.currentPeriodEnd
              ? formatDate(user.subscription.currentPeriodEnd)
              : 'Not available'}
          </dd>
        </dl>
      ) : (
        <p>Not subscribed.</p>
      )}
      <p className="admin-note">
        Read-only: subscription state is driven only by verified Stripe events, never set manually.
      </p>
    </article>
  );
}

function CharityCard({ user }: { user: AdminUserDetailDto }) {
  return (
    <article aria-labelledby="admin-user-charity-heading">
      <h3 id="admin-user-charity-heading">Charity</h3>
      {user.charity ? (
        <p>
          {user.charity.name} — {formatPercent(user.percentageBps)}
          {user.charity.isArchived && ' (archived)'}
        </p>
      ) : (
        <p>No charity selected.</p>
      )}
    </article>
  );
}

function WinnersCard({ user }: { user: AdminUserDetailDto }) {
  return (
    <article aria-labelledby="admin-user-winners-heading">
      <h3 id="admin-user-winners-heading">Winnings</h3>
      {user.winners.length === 0 ? (
        <p>No winnings yet.</p>
      ) : (
        <ul aria-label="This user's winnings">
          {user.winners.map((w) => (
            <li key={w.id}>
              {w.drawMonth} — {formatMinorUnits(w.prizeMinor, w.currency)} ({w.matchCount}-match) —{' '}
              {w.verificationStatus} / {w.payoutStatus}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ScoresCard({
  user,
  onChange,
}: {
  user: AdminUserDetailDto;
  onChange: () => Promise<void>;
}) {
  const { getAccessToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ playedOn: string; value: string } | null>(null);

  const submitAdd = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setNotice(null);
      const form = event.currentTarget;
      const playedOn = (form.elements.namedItem('playedOn') as HTMLInputElement).value;
      const scoreText = (form.elements.namedItem('stablefordScore') as HTMLInputElement).value;
      const stablefordScore = Number(scoreText);
      const dateProblem = playedOnError(playedOn);
      const scoreProblem = stablefordScoreError(stablefordScore);
      if (dateProblem ?? scoreProblem) {
        setError(dateProblem ?? scoreProblem);
        return;
      }
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        const result = await addAdminUserScore(token, user.id, { playedOn, stablefordScore });
        form.reset();
        setNotice(
          result.replacedPlayedOn
            ? `Saved. Replaced their oldest score (${result.replacedPlayedOn}).`
            : 'Saved.',
        );
        await onChange();
      } catch (err) {
        setError(
          err instanceof ApiRequestError && err.serverMessage
            ? err.serverMessage
            : 'Could not save that score.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, onChange, user.id],
  );

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const value = Number(editing.value);
    const problem = stablefordScoreError(value);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      await updateAdminUserScore(token, user.id, editing.playedOn, { stablefordScore: value });
      setEditing(null);
      setNotice('Saved.');
      await onChange();
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.serverMessage
          ? err.serverMessage
          : 'Could not save that change.',
      );
    } finally {
      setBusy(false);
    }
  }, [editing, getAccessToken, onChange, user.id]);

  const remove = useCallback(
    async (playedOn: string) => {
      if (!window.confirm(`Delete this user's score for ${playedOn}?`)) return;
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        await deleteAdminUserScore(token, user.id, playedOn);
        setNotice('Deleted.');
        await onChange();
      } catch (err) {
        setError(
          err instanceof ApiRequestError && err.serverMessage
            ? err.serverMessage
            : 'Could not delete that score.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, onChange, user.id],
  );

  return (
    <article aria-labelledby="admin-user-scores-heading">
      <h3 id="admin-user-scores-heading">Scores</h3>
      {user.scores.length === 0 ? (
        <p>No scores recorded yet.</p>
      ) : (
        <ul aria-label="This user's scores">
          {user.scores.map((score) => (
            <li key={score.id}>
              {editing && editing.playedOn === score.playedOn ? (
                <>
                  {score.playedOn}:{' '}
                  <input
                    type="number"
                    min={1}
                    max={45}
                    step={1}
                    aria-label={`Score for ${score.playedOn}`}
                    value={editing.value}
                    onChange={(e) => {
                      setEditing({ playedOn: score.playedOn, value: e.target.value });
                    }}
                  />
                  <button type="button" disabled={busy} onClick={() => void saveEdit()}>
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {score.playedOn}: {score.stablefordScore}{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setEditing({
                        playedOn: score.playedOn,
                        value: String(score.stablefordScore),
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" disabled={busy} onClick={() => void remove(score.playedOn)}>
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <form onSubmit={(e) => void submitAdd(e)} noValidate>
        <label>
          Date played
          <input type="date" name="playedOn" required />
        </label>
        <label>
          Stableford score
          <input type="number" name="stablefordScore" min={1} max={45} step={1} required />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add score'}
        </button>
      </form>
    </article>
  );
}
