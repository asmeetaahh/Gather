import { useEffect, useState, type FormEvent } from 'react';
import {
  CHARITY_LIST_DEFAULT_LIMIT,
  type CharityListQuery,
  type ListCharitiesResponse,
} from '@gather/shared';
import { fetchCharities } from '../api/charities';
import { ApiRequestError } from '../api/client';
import { CharitySummaryItem } from './CharitySummaryItem';

/** The outcome of loading ONE query. It is only shown while it still matches the query being displayed. */
type Outcome =
  | { query: CharityListQuery; error: string }
  | { query: CharityListQuery; result: ListCharitiesResponse };

/** Public directory (DIR-01): search by text, filter by tag or featured, page through the results. */
export function CharitiesPage() {
  // What the visitor is typing, and what was last submitted (the query that is actually loaded).
  const [text, setText] = useState('');
  const [tag, setTag] = useState('');
  const [featured, setFeatured] = useState(false);
  const [applied, setApplied] = useState<CharityListQuery>({
    limit: CHARITY_LIST_DEFAULT_LIMIT,
    offset: 0,
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // No matching outcome yet means the current query is still loading.
  const load = outcome?.query === applied ? outcome : null;

  useEffect(() => {
    const controller = new AbortController();
    fetchCharities(applied, controller.signal)
      .then((result) => {
        setOutcome({ query: applied, result });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A 400 means the search text or tag was not acceptable: say so; otherwise it is a generic failure.
        const message =
          error instanceof ApiRequestError && error.status === 400
            ? 'That search is not valid. Please check it and try again.'
            : 'Charities could not be loaded. Please try again.';
        setOutcome({ query: applied, error: message });
      });
    return () => {
      controller.abort();
    };
  }, [applied]);

  function search(event: FormEvent) {
    event.preventDefault();
    const next: CharityListQuery = { limit: CHARITY_LIST_DEFAULT_LIMIT, offset: 0 };
    if (text.trim()) next.q = text.trim();
    if (tag.trim()) next.tag = tag.trim().toLowerCase();
    if (featured) next.featured = true;
    setApplied(next);
  }

  const page = (offset: number) => {
    setApplied({ ...applied, offset });
  };

  return (
    <section>
      <h1>Charities</h1>
      <form onSubmit={search} role="search" noValidate>
        <label>
          Search charities
          <input
            type="search"
            name="q"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </label>
        <label>
          Tag
          <input
            type="text"
            name="tag"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
            }}
          />
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              name="featured"
              checked={featured}
              onChange={(e) => {
                setFeatured(e.target.checked);
              }}
            />{' '}
            Featured only
          </span>
        </label>
        <button type="submit">Search</button>
      </form>

      {!load && <p role="status">Loading charities…</p>}
      {load && 'error' in load && <p role="alert">{load.error}</p>}
      {load && 'result' in load && (
        <>
          {load.result.charities.length === 0 ? (
            <p role="status">No charities match your search.</p>
          ) : (
            <ul aria-label="Charities">
              {load.result.charities.map((charity) => (
                <CharitySummaryItem key={charity.id} charity={charity} />
              ))}
            </ul>
          )}
          <p>
            {applied.offset > 0 && (
              <button
                type="button"
                onClick={() => {
                  page(Math.max(0, applied.offset - applied.limit));
                }}
              >
                Previous
              </button>
            )}{' '}
            {load.result.hasMore && (
              <button
                type="button"
                onClick={() => {
                  page(applied.offset + applied.limit);
                }}
              >
                Next
              </button>
            )}
          </p>
        </>
      )}
    </section>
  );
}
