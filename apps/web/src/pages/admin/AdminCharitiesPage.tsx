import { useCallback, useState, type FormEvent } from 'react';
import { isValidCharitySlug, type AdminCharityDto } from '@gather/shared';
import {
  archiveCharity,
  createCharity,
  fetchAdminCharities,
  unarchiveCharity,
  updateCharity,
} from '../../api/charities';
import { ApiRequestError } from '../../api/client';
import { useAuth } from '../../auth/context';
import { useMyData } from '../../lib/useMyData';

/**
 * Charity management (PRD §11 ADM-05): create, edit, feature and archive charities — reusing the same
 * `@gather/shared` slug/name/description/tags validation as the rest of the charity feature. Image and
 * event management is deliberately NOT built here: nothing in Phase 4/9 lets anyone edit charity
 * images or events through the API (they stay SQL/dashboard-managed; DECISIONS D-065/D-074).
 */
export function AdminCharitiesPage() {
  const { load, reload } = useMyData(fetchAdminCharities, 'Charities could not be loaded.');

  return (
    <section aria-labelledby="admin-charities-heading">
      <h2 id="admin-charities-heading">Charities</h2>

      {load.status === 'loading' && <p role="status">Loading charities…</p>}
      {load.status === 'error' && <p role="alert">{load.message}</p>}
      {load.status === 'ready' && (
        <CharitiesList charities={load.data.charities} onChange={reload} />
      )}

      <CreateCharityForm onCreated={reload} />
    </section>
  );
}

function CharitiesList({
  charities,
  onChange,
}: {
  charities: AdminCharityDto[];
  onChange: () => Promise<void>;
}) {
  if (charities.length === 0) return <p>No charities yet.</p>;
  return (
    <ul aria-label="Charities">
      {charities.map((c) => (
        <CharityRow key={c.id} charity={c} onChange={onChange} />
      ))}
    </ul>
  );
}

function CharityRow({
  charity,
  onChange,
}: {
  charity: AdminCharityDto;
  onChange: () => Promise<void>;
}) {
  const { getAccessToken } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(charity.name);
  const [description, setDescription] = useState(charity.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saveEdit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        await updateCharity(token, charity.id, { name, description });
        setEditing(false);
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
    [charity.id, description, getAccessToken, name, onChange],
  );

  const toggleFeatured = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      await updateCharity(token, charity.id, { isFeatured: !charity.isFeatured });
      await onChange();
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.serverMessage
          ? err.serverMessage
          : 'Could not change featured status.',
      );
    } finally {
      setBusy(false);
    }
  }, [charity.id, charity.isFeatured, getAccessToken, onChange]);

  const toggleArchived = useCallback(async () => {
    const action = charity.isArchived ? 'unarchive' : 'archive';
    if (
      action === 'archive' &&
      !window.confirm(
        `Archive "${charity.name}"? It will disappear from the public directory, spotlight and signup form. Anyone already supporting it keeps their choice until they change it.`,
      )
    )
      return;
    setError(null);
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      if (action === 'archive') await archiveCharity(token, charity.id);
      else await unarchiveCharity(token, charity.id);
      await onChange();
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.serverMessage
          ? err.serverMessage
          : `Could not ${action} this charity.`,
      );
    } finally {
      setBusy(false);
    }
  }, [charity.id, charity.isArchived, charity.name, getAccessToken, onChange]);

  return (
    <li>
      {editing ? (
        <form onSubmit={(e) => void saveEdit(e)} noValidate aria-label={`Edit ${charity.name}`}>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              required
            />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <strong>{charity.name}</strong> ({charity.slug}){charity.isArchived && ' — archived'}
          {charity.isFeatured && ' — featured'}
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button type="button" disabled={busy} onClick={() => void toggleFeatured()}>
              {charity.isFeatured ? 'Unfeature' : 'Feature'}
            </button>
            <button type="button" disabled={busy} onClick={() => void toggleArchived()}>
              {charity.isArchived ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </li>
  );
}

function CreateCharityForm({ onCreated }: { onCreated: () => Promise<void> }) {
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
      const slug = (form.elements.namedItem('slug') as HTMLInputElement).value.trim();
      const name = (form.elements.namedItem('name') as HTMLInputElement).value;
      const description = (form.elements.namedItem('description') as HTMLInputElement).value;
      if (!isValidCharitySlug(slug)) {
        setError('Slug must be lower-case letters, digits and hyphens.');
        return;
      }
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        await createCharity(token, { slug, name, description });
        form.reset();
        setNotice('Charity created.');
        await onCreated();
      } catch (err) {
        setError(
          err instanceof ApiRequestError && err.serverMessage
            ? err.serverMessage
            : 'Could not create that charity.',
        );
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, onCreated],
  );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Create a charity">
      <h3>Add a charity</h3>
      <label>
        Slug
        <input name="slug" required pattern="[a-z0-9-]+" />
      </label>
      <label>
        Name
        <input name="name" required />
      </label>
      <label>
        Description
        <input name="description" required />
      </label>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Add charity'}
      </button>
    </form>
  );
}
