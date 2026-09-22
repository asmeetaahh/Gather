import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CHARITY_LIST_MAX_LIMIT, isUuid, type CharitySummaryDto } from '@gather/shared';
import { fetchCharities } from '../api/charities';
import { useAuth } from '../auth/context';
import { AuthForm } from './AuthForm';

type Load =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; charities: CharitySummaryDto[] };

/**
 * Signup collects the charity the user wants to support (PRD §08 CHR-01: "users select a charity at signup").
 * A charity picked earlier on a profile page arrives as `?charity=<id>` and is pre-selected; otherwise the
 * visitor must choose one. Only listed charities are offered. The choice is sent with the signup and recorded
 * by the database (D-065); it can be changed later on /account/charity. This form is UX: the API refuses to
 * start a subscription for a user without an active selected charity, whatever this page did.
 */
export function SignupPage() {
  const { signUp } = useAuth();
  const [search] = useSearchParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchCharities({ limit: CHARITY_LIST_MAX_LIMIT, offset: 0 }, controller.signal)
      .then(({ charities }) => {
        setLoad({ status: 'ready', charities });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ status: 'error' });
      });
    return () => {
      controller.abort();
    };
  }, []);

  const charities = load.status === 'ready' ? load.charities : [];
  const suggested = search.get('charity');
  const preselected =
    isUuid(suggested) && charities.some((c) => c.id === suggested) ? suggested : '';
  const charityId = picked ?? preselected;
  // What "Log in" carries forward. Deliberately NOT gated on the list having loaded: a visitor who clicks straight
  // away must not lose the choice. /account/charity checks it against the listed charities itself.
  const carried = charityId || (isUuid(suggested) ? suggested : '');

  const problem =
    load.status === 'error'
      ? 'Charities could not be loaded, so sign-up is unavailable right now. Please try again later.'
      : load.status === 'ready' && charities.length === 0
        ? 'There are no charities to choose from yet, so sign-up is not open.'
        : null;

  return (
    <AuthForm
      title="Create your account"
      submitLabel="Sign up"
      passwordAutoComplete="new-password"
      onSubmit={(email, password) => signUp(email, password, { charityId })}
      extraFields={
        <>
          <label>
            Charity
            <select
              name="charity"
              value={charityId}
              onChange={(e) => {
                setPicked(e.target.value);
              }}
            >
              <option value="">Choose a charity to support</option>
              {charities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {problem && <p role="alert">{problem}</p>}
        </>
      }
      validateExtra={() => (charityId ? null : 'Choose the charity you want to support.')}
      submitDisabled={load.status !== 'ready' || charities.length === 0}
      // If the project requires email confirmation there is no session yet: tell the user what to do.
      // Otherwise a session exists and <GuestOnly> redirects immediately.
      successNotice={(result) =>
        result.ok && result.needsEmailConfirmation
          ? 'Almost there! Check your email for a confirmation link, then log in.'
          : null
      }
      footer={
        <p>
          Already have an account?{' '}
          <Link
            to="/login"
            // Someone who already has an account keeps their pre-signup choice: after logging in they land on
            // /account/charity with it pre-selected.
            {...(carried && { state: { from: `/account/charity?charity=${carried}` } })}
          >
            Log in
          </Link>
        </p>
      }
    />
  );
}
