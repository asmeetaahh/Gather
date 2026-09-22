import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CHARITY_LIST_MAX_LIMIT,
  checkCharityPercentage,
  formatPercent,
  isUuid,
  percentToBps,
  type CharityPreferenceDto,
  type CharitySummaryDto,
  type UpdateCharityPreferenceRequest,
} from '@gather/shared';
import { fetchCharities, fetchMyCharity, updateMyCharity } from '../api/charities';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/context';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preference: CharityPreferenceDto; charities: CharitySummaryDto[] };

/**
 * The signed-in user's charity and contribution percentage (CHR-01..03). The percentage is checked here
 * for immediate feedback, but the server applies the same rules and is the authority (D-005, D-064): a
 * value from the PRD minimum (10%) up can be set at any time, raising or lowering.
 */
export function CharityPreferencePage() {
  const { getAccessToken } = useAuth();
  const [search] = useSearchParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [charityId, setCharityId] = useState('');
  const [percent, setPercent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        const [{ preference }, list] = await Promise.all([
          fetchMyCharity(token),
          fetchCharities({ limit: CHARITY_LIST_MAX_LIMIT, offset: 0 }),
        ]);
        if (cancelled) return;
        // "Choose this charity" on a profile links here with ?charity=<id>.
        const suggested = search.get('charity');
        const preselect =
          isUuid(suggested) && list.charities.some((c) => c.id === suggested) ? suggested : null;
        const current =
          preference.charity && !preference.charity.isArchived ? preference.charity.id : '';
        setCharityId(preselect ?? current);
        setPercent(String(preference.percentageBps / 100));
        setLoad({ status: 'ready', preference, charities: list.charities });
      } catch {
        if (!cancelled)
          setLoad({ status: 'error', message: 'Your charity settings could not be loaded.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, search]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (load.status !== 'ready') return;
    setError(null);
    setSaved(false);

    // Same rule the server enforces; checked first so a bad value never costs a round trip.
    const bps = percentToBps(percent);
    const check = bps === null ? null : checkCharityPercentage(bps, load.preference.maxBps);
    if (bps === null) {
      setError('Enter a percentage such as 10 or 12.5.');
      return;
    }
    if (check && !check.ok) {
      setError(check.message);
      return;
    }

    const body: UpdateCharityPreferenceRequest = { percentageBps: bps };
    if (charityId && charityId !== load.preference.charity?.id) body.charityId = charityId;

    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      const { preference } = await updateMyCharity(token, body);
      setLoad({ ...load, preference });
      setPercent(String(preference.percentageBps / 100));
      setSaved(true);
    } catch (caught) {
      // Show the server's own explanation (e.g. below the minimum, charity no longer available).
      setError(
        caught instanceof ApiRequestError && caught.serverMessage
          ? caught.serverMessage
          : 'Your changes could not be saved. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (load.status === 'loading') return <p role="status">Loading your charity settings…</p>;
  if (load.status === 'error') return <p role="alert">{load.message}</p>;

  const { preference, charities } = load;
  const current = preference.charity;
  return (
    <section>
      <h1>Your charity</h1>
      {current?.isArchived && (
        <p role="alert">
          {current.name} is no longer listed. Please choose another charity — you need a listed
          charity to subscribe.
        </p>
      )}
      {!current && <p role="status">Choose a charity: you need one to subscribe.</p>}
      <form
        onSubmit={(e) => {
          void save(e);
        }}
        noValidate
      >
        <label>
          Charity
          <select
            name="charity"
            value={charityId}
            onChange={(e) => {
              setCharityId(e.target.value);
            }}
          >
            <option value="">Choose a charity</option>
            {charities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Contribution percentage
          <input
            type="text"
            inputMode="decimal"
            name="percentage"
            value={percent}
            onChange={(e) => {
              setPercent(e.target.value);
            }}
          />
        </label>
        <p>
          At least {formatPercent(preference.minBps)}
          {preference.maxBps !== null && <>, at most {formatPercent(preference.maxBps)}</>}. You can
          raise or lower it at any time.
        </p>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">Saved.</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}
