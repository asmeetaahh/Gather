import { useState, type FormEvent, type ReactNode } from 'react';
import { validateCredentials } from '../auth/helpers';
import type { AuthActionResult } from '../auth/types';

/**
 * Shared email + password form for login and signup. Validation errors and server errors are shown in
 * an `alert` region; the button is disabled while a request is in flight to prevent double submits.
 */
export function AuthForm(props: {
  title: string;
  submitLabel: string;
  passwordAutoComplete: 'current-password' | 'new-password';
  onSubmit: (email: string, password: string) => Promise<AuthActionResult>;
  /** Shown instead of the form once the action reports success without a session (e.g. email confirmation). */
  successNotice?: (result: AuthActionResult) => string | null;
  footer?: ReactNode;
  /** Extra fields rendered after the password (signup adds the charity choice, CHR-01). */
  extraFields?: ReactNode;
  /** Checked after the credentials; return a message to stop the submit, or null to go ahead. */
  validateExtra?: () => string | null;
  /** True while the form cannot be submitted at all (e.g. the charity list could not be loaded). */
  submitDisabled?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const check = validateCredentials(email, password);
    if (!check.ok) {
      setError(check.message);
      return;
    }

    const extra = props.validateExtra?.() ?? null;
    if (extra) {
      setError(extra);
      return;
    }

    setBusy(true);
    const result = await props.onSubmit(check.email, password);
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPassword('');
    setNotice(props.successNotice?.(result) ?? null);
  }

  if (notice) {
    return (
      <section>
        <h1>{props.title}</h1>
        <p role="status">{notice}</p>
      </section>
    );
  }

  return (
    <section>
      <h1>{props.title}</h1>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <label>
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete={props.passwordAutoComplete}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>
        {props.extraFields}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || props.submitDisabled}>
          {busy ? 'Please wait…' : props.submitLabel}
        </button>
      </form>
      {props.footer}
    </section>
  );
}
