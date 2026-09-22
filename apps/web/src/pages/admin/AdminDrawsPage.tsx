import { useCallback, useState, type FormEvent } from 'react';
import {
  DRAW_MODES,
  formatMinorUnits,
  type DrawDetailDto,
  type DrawMode,
  type DrawSummaryDto,
} from '@gather/shared';
import {
  createDraw,
  fetchAdminDraw,
  fetchAdminDraws,
  publishDraw,
  simulateDraw,
} from '../../api/draws';
import { ApiRequestError } from '../../api/client';
import { useAuth } from '../../auth/context';
import { useMyData } from '../../lib/useMyData';

/**
 * Draw management (PRD §11 ADM-02/03/04): view/create draws, run simulation, publish. Every action
 * here calls the EXISTING Phase 6 draw engine (`DrawService.simulate`/`publish`) through the same
 * `/api/admin/draws` contract — number-drawing, tier shares and rollover are not reimplemented.
 */
export function AdminDrawsPage() {
  const { load, reload } = useMyData(fetchAdminDraws, 'Draws could not be loaded.');
  const { getAccessToken } = useAuth();
  const [selected, setSelected] = useState<DrawDetailDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const open = useCallback(
    async (id: string) => {
      setActionError(null);
      const token = await getAccessToken();
      if (!token) return;
      try {
        const { draw } = await fetchAdminDraw(token, id);
        setSelected(draw);
      } catch {
        setActionError('Could not load that draw.');
      }
    },
    [getAccessToken],
  );

  const runSimulate = useCallback(
    async (id: string) => {
      setActionError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const { draw } = await simulateDraw(token, id);
        setSelected(draw);
        await reload();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not simulate this draw.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, reload],
  );

  const runPublish = useCallback(
    async (id: string) => {
      if (
        !window.confirm(
          'Publish this draw? Once published, its results and winners are permanent and cannot be changed.',
        )
      )
        return;
      setActionError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) return;
        const { draw } = await publishDraw(token, id);
        setSelected(draw);
        await reload();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError && error.serverMessage
            ? error.serverMessage
            : 'Could not publish this draw.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, reload],
  );

  return (
    <section aria-labelledby="admin-draws-heading">
      <h2 id="admin-draws-heading">Draws</h2>

      {load.status === 'loading' && <p role="status">Loading draws…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && (
        <DrawsList draws={load.data.draws} onSelect={(id) => void open(id)} />
      )}

      <CreateDrawForm onCreated={reload} />

      {selected && (
        <DrawDetail
          draw={selected}
          busy={busy}
          error={actionError}
          onSimulate={() => void runSimulate(selected.id)}
          onPublish={() => void runPublish(selected.id)}
        />
      )}
    </section>
  );
}

function DrawsList({
  draws,
  onSelect,
}: {
  draws: DrawSummaryDto[];
  onSelect: (id: string) => void;
}) {
  if (draws.length === 0) return <p>No draws yet.</p>;
  return (
    <ul aria-label="Draws">
      {draws.map((d) => (
        <li key={d.id}>
          <button type="button" onClick={() => onSelect(d.id)}>
            {d.drawMonth} — {d.mode} — {d.status}
            {d.prizePoolMinor !== null &&
              d.currency &&
              ` — ${formatMinorUnits(d.prizePoolMinor, d.currency)}`}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CreateDrawForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const { getAccessToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setNotice(null);
      const form = event.currentTarget;
      const month = (form.elements.namedItem('drawMonth') as HTMLInputElement).value;
      const mode = (form.elements.namedItem('mode') as HTMLSelectElement).value as DrawMode;
      const drawMonth = month ? `${month}-01` : '';
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        await createDraw(token, { drawMonth, mode });
        form.reset();
        setNotice('Draw created.');
        await onCreated();
      } catch (err) {
        setError(
          err instanceof ApiRequestError && err.serverMessage
            ? err.serverMessage
            : 'Could not create that draw.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, onCreated],
  );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Create a draw">
      <h3>Create a draw</h3>
      <label>
        Month
        <input type="month" name="drawMonth" required />
      </label>
      <label>
        Mode
        <select name="mode" defaultValue="random">
          {DRAW_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create draw'}
      </button>
    </form>
  );
}

function DrawDetail({
  draw,
  busy,
  error,
  onSimulate,
  onPublish,
}: {
  draw: DrawDetailDto;
  busy: boolean;
  error: string | null;
  onSimulate: () => void;
  onPublish: () => void;
}) {
  return (
    <div aria-label="Draw detail">
      <h3>
        {draw.drawMonth} — {draw.mode} — {draw.status}
      </h3>
      {error && <p role="alert">{error}</p>}
      {draw.winningNumbers ? (
        <p>Winning numbers: {draw.winningNumbers.join(', ')}</p>
      ) : (
        <p>Not simulated yet.</p>
      )}
      {draw.prizePoolMinor !== null && draw.currency && (
        <p>Prize pool: {formatMinorUnits(draw.prizePoolMinor, draw.currency)}</p>
      )}
      {draw.tierResults.length > 0 && (
        <table>
          <caption>Tier results</caption>
          <thead>
            <tr>
              <th scope="col">Matches</th>
              <th scope="col">Winners</th>
              <th scope="col">Per winner</th>
              <th scope="col">Rolls over</th>
            </tr>
          </thead>
          <tbody>
            {draw.tierResults.map((t) => (
              <tr key={t.matchCount}>
                <td>{t.matchCount}</td>
                <td>{t.winnersCount}</td>
                <td>
                  {draw.currency
                    ? formatMinorUnits(t.prizePerWinnerMinor, draw.currency)
                    : t.prizePerWinnerMinor}
                </td>
                <td>{t.rollsOver ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {draw.status === 'draft' && (
        <button type="button" disabled={busy} onClick={onSimulate}>
          {busy ? 'Simulating…' : 'Simulate'}
        </button>
      )}
      {draw.status === 'simulated' && (
        <>
          <button type="button" disabled={busy} onClick={onSimulate}>
            {busy ? 'Re-simulating…' : 'Re-simulate'}
          </button>
          <button type="button" disabled={busy} onClick={onPublish}>
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </>
      )}
      {draw.status === 'published' && <p>This draw is published and permanent.</p>}
    </div>
  );
}
