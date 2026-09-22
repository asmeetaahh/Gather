import { useCallback, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  formatMinorUnits,
  formatPercent,
  playedOnError,
  stablefordScoreError,
  type CharityPreferenceDto,
  type CreateScoreRequest,
  type ListMyDrawParticipationResponse,
  type ListScoresResponse,
  type ListWinnersResponse,
  type ScoreDto,
  type SubscriptionResponse,
} from '@gather/shared';
import { fetchMyCharity } from '../api/charities';
import { fetchMyDraws } from '../api/draws';
import { ApiRequestError } from '../api/client';
import { addScore, deleteScore, fetchMyScores, updateScore } from '../api/scores';
import { fetchMySubscription } from '../api/billing';
import { fetchMyWinners } from '../api/winners';
import { useAuth } from '../auth/context';
import { useMyData } from '../lib/useMyData';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * The signed-in user's dashboard (PRD §10 DSH-01..05): subscription, scores, charity, draw
 * participation and winnings, each loading and failing independently. Deeper management for
 * subscription/charity/winnings stays on their own already-built pages (`/account/subscription`,
 * `/account/charity`, `/account/winnings`) — this page shows real, current summaries of the same
 * data and links to them, rather than duplicating their logic. Score entry/edit/delete is the one
 * area with no page yet (Phase 3 built only the API), so it lives here in full.
 */
export function DashboardPage() {
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

      <div className="dashboard-grid">
        <SubscriptionCard />
        <CharityCard />
        <DrawsCard />
        <WinningsCard />
      </div>

      <ScoresCard />
    </section>
  );
}

// ---- Subscription (DSH-01) ---------------------------------------------------------------------

function SubscriptionCard() {
  const { load } = useMyData(fetchMySubscription, 'Your subscription could not be loaded.');

  return (
    <article aria-labelledby="dashboard-subscription-heading">
      <h2 id="dashboard-subscription-heading">Subscription</h2>
      {load.status === 'loading' && <p role="status">Loading…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && <SubscriptionSummary response={load.data} />}
    </article>
  );
}

function SubscriptionSummary({ response }: { response: SubscriptionResponse }) {
  const sub = response.subscription;
  if (!sub) {
    return (
      <p>
        You are not subscribed yet. <Link to="/account/subscription">Choose a plan</Link>.
      </p>
    );
  }
  return (
    <>
      <p>
        {sub.planName} ({sub.interval === 'month' ? 'monthly' : 'yearly'}) —{' '}
        <strong>{sub.status}</strong>
      </p>
      {sub.status === 'active' && sub.currentPeriodEnd && (
        <p>
          {sub.cancelAtPeriodEnd ? 'Ends on ' : 'Renews on '}
          {formatDate(sub.currentPeriodEnd)}
          {sub.cancelAtPeriodEnd && ' — you keep access until then.'}
        </p>
      )}
      {sub.status === 'pending' && <p>Waiting for the first payment to be confirmed.</p>}
      {sub.status === 'lapsed' && (
        <p role="alert">Your last payment did not go through. Update your payment details.</p>
      )}
      {sub.status === 'cancelled' && sub.endedAt && <p>Ended on {formatDate(sub.endedAt)}.</p>}
      <p>
        <Link to="/account/subscription">Manage subscription</Link>
      </p>
    </>
  );
}

// ---- Charity (DSH-03) ---------------------------------------------------------------------------

function CharityCard() {
  const { load } = useMyData(fetchMyCharity, 'Your charity could not be loaded.');

  return (
    <article aria-labelledby="dashboard-charity-heading">
      <h2 id="dashboard-charity-heading">Charity</h2>
      {load.status === 'loading' && <p role="status">Loading…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && <CharitySummary preference={load.data.preference} />}
    </article>
  );
}

function CharitySummary({ preference }: { preference: CharityPreferenceDto }) {
  if (!preference.charity) {
    return (
      <p>
        No charity selected yet. <Link to="/account/charity">Choose one</Link>.
      </p>
    );
  }
  return (
    <>
      <p>
        {preference.charity.name} — {formatPercent(preference.percentageBps)} of your subscription.
      </p>
      {preference.charity.isArchived && (
        <p role="alert">This charity is no longer listed — choose another to keep subscribing.</p>
      )}
      <p>
        <Link to="/account/charity">Change charity or percentage</Link>
      </p>
    </>
  );
}

// ---- Draw participation (DSH-04) -----------------------------------------------------------------

function DrawsCard() {
  const { load } = useMyData(fetchMyDraws, 'Your draw participation could not be loaded.');

  return (
    <article aria-labelledby="dashboard-draws-heading">
      <h2 id="dashboard-draws-heading">Draws</h2>
      {load.status === 'loading' && <p role="status">Loading…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && <DrawsSummary response={load.data} />}
    </article>
  );
}

function DrawsSummary({ response }: { response: ListMyDrawParticipationResponse }) {
  if (response.draws.length === 0) {
    return (
      <p>
        You have not been entered in a published draw yet. Draws run monthly — once one is
        published, your result appears here.
      </p>
    );
  }
  return (
    <ul aria-label="Your draw participation">
      {response.draws.map((d) => (
        <li key={d.drawId}>
          {d.drawMonth} — {d.matchCount} of 5 matched ({d.mode})
        </li>
      ))}
    </ul>
  );
}

// ---- Winnings (DSH-05) ---------------------------------------------------------------------------

function WinningsCard() {
  const { load } = useMyData(fetchMyWinners, 'Your winnings could not be loaded.');

  return (
    <article aria-labelledby="dashboard-winnings-heading">
      <h2 id="dashboard-winnings-heading">Winnings</h2>
      {load.status === 'loading' && <p role="status">Loading…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && <WinningsSummary response={load.data} />}
    </article>
  );
}

function WinningsSummary({ response }: { response: ListWinnersResponse }) {
  if (response.winners.length === 0) {
    return <p>You have not won a draw yet.</p>;
  }
  const totalPaid = response.winners.filter((w) => w.payoutStatus === 'paid');
  return (
    <>
      <p>
        {response.winners.length} win{response.winners.length === 1 ? '' : 's'}
        {totalPaid.length > 0 && ` — ${String(totalPaid.length)} paid`}.
      </p>
      <ul aria-label="Your winnings">
        {response.winners.map((w) => (
          <li key={w.id}>
            {w.drawMonth} — {formatMinorUnits(w.prizeMinor, w.currency)} ({w.matchCount}-match) —{' '}
            {w.verificationStatus} / {w.payoutStatus}
          </li>
        ))}
      </ul>
      <p>
        <Link to="/account/winnings">View and manage proof</Link>
      </p>
    </>
  );
}

// ---- Scores (DSH-02) — full entry/edit/delete interface -------------------------------------------

function ScoresCard() {
  const { load, reload } = useMyData(fetchMyScores, 'Your scores could not be loaded.');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ playedOn: string; value: string } | null>(null);
  const { getAccessToken } = useAuth();

  const submitAdd = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFormError(null);
      setNotice(null);
      const form = event.currentTarget;
      const playedOn = (form.elements.namedItem('playedOn') as HTMLInputElement).value;
      const scoreText = (form.elements.namedItem('stablefordScore') as HTMLInputElement).value;
      const stablefordScore = Number(scoreText);

      // The same rules the server enforces, checked first so an obviously bad value never costs a
      // round trip (item 9: the server remains authoritative either way — it checks again).
      const dateProblem = playedOnError(playedOn);
      const scoreProblem = stablefordScoreError(stablefordScore);
      if (dateProblem ?? scoreProblem) {
        setFormError(dateProblem ?? scoreProblem);
        return;
      }

      const body: CreateScoreRequest = { playedOn, stablefordScore };
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        const result = await addScore(token, body);
        form.reset();
        setNotice(
          result.replacedPlayedOn
            ? `Saved. Replaced your oldest score (${result.replacedPlayedOn}).`
            : 'Saved.',
        );
        await reload();
      } catch (error) {
        setFormError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not save that score. Please try again.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, reload],
  );

  const startEdit = useCallback((score: ScoreDto) => {
    setFormError(null);
    setNotice(null);
    setEditing({ playedOn: score.playedOn, value: String(score.stablefordScore) });
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const value = Number(editing.value);
    const problem = stablefordScoreError(value);
    if (problem) {
      setFormError(problem);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      await updateScore(token, editing.playedOn, { stablefordScore: value });
      setEditing(null);
      setNotice('Saved.');
      await reload();
    } catch (error) {
      setFormError(
        error instanceof ApiRequestError && error.serverMessage
          ? error.serverMessage
          : 'Could not save that change. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [editing, getAccessToken, reload]);

  const remove = useCallback(
    async (playedOn: string) => {
      if (!window.confirm(`Delete your score for ${playedOn}?`)) return;
      setFormError(null);
      setNotice(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        await deleteScore(token, playedOn);
        setNotice('Deleted.');
        await reload();
      } catch (error) {
        setFormError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not delete that score. Please try again.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, reload],
  );

  return (
    <article aria-labelledby="dashboard-scores-heading">
      <h2 id="dashboard-scores-heading">Your scores</h2>
      {load.status === 'loading' && <p role="status">Loading…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && (
        <ScoresList
          response={load.data}
          editing={editing}
          busy={busy}
          onEdit={startEdit}
          onEditChange={(value) => {
            setEditing((prev) => (prev ? { ...prev, value } : prev));
          }}
          onSaveEdit={() => void saveEdit()}
          onCancelEdit={() => {
            setEditing(null);
            setFormError(null);
          }}
          onDelete={(playedOn) => void remove(playedOn)}
        />
      )}

      <form onSubmit={(e) => void submitAdd(e)} noValidate>
        <label>
          Date played
          <input type="date" name="playedOn" required />
        </label>
        <label>
          Stableford score
          <input type="number" name="stablefordScore" min={1} max={45} step={1} required />
        </label>
        {formError && <p role="alert">{formError}</p>}
        {notice && <p role="status">{notice}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add score'}
        </button>
      </form>
    </article>
  );
}

function ScoresList({
  response,
  editing,
  busy,
  onEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: {
  response: ListScoresResponse;
  editing: { playedOn: string; value: string } | null;
  busy: boolean;
  onEdit: (score: ScoreDto) => void;
  onEditChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (playedOn: string) => void;
}) {
  if (response.scores.length === 0) {
    return <p>You have not entered any scores yet. Your last 5 are kept, newest first.</p>;
  }
  return (
    <>
      <p>
        {response.scores.length} of 5 scores recorded.
        {response.scores.length === 5 && ' Adding a new one replaces the oldest.'}
      </p>
      <ul aria-label="Your scores">
        {response.scores.map((score) => (
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
                    onEditChange(e.target.value);
                  }}
                />
                <button type="button" disabled={busy} onClick={onSaveEdit}>
                  Save
                </button>
                <button type="button" disabled={busy} onClick={onCancelEdit}>
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
                    onEdit(score);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onDelete(score.playedOn);
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
