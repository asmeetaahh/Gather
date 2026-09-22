import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CharityDetailDto } from '@gather/shared';
import { fetchCharity } from '../api/charities';
import { useAuth } from '../auth/context';
import { ApiRequestError } from '../api/client';

/** The outcome of loading ONE slug; it is only shown while the page is still on that slug. */
type Outcome =
  | { slug: string; status: 'not-found' }
  | { slug: string; status: 'error' }
  | { slug: string; status: 'ready'; charity: CharityDetailDto };

const formatDateTime = (iso: string) => new Date(iso).toLocaleString();

/** Public charity profile (DIR-02): description, images, upcoming events. */
export function CharityDetailPage() {
  const { slug = '' } = useParams();
  const { state: auth } = useAuth();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchCharity(slug, controller.signal)
      .then(({ charity }) => {
        setOutcome({ slug, status: 'ready', charity });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({
          slug,
          status: error instanceof ApiRequestError && error.status === 404 ? 'not-found' : 'error',
        });
      });
    return () => {
      controller.abort();
    };
  }, [slug]);

  // No outcome for this slug yet: still loading.
  const load = outcome?.slug === slug ? outcome : null;
  if (!load) return <p role="status">Loading charity…</p>;
  if (load.status === 'not-found')
    return (
      <section>
        <h1>Charity not found</h1>
        <p>
          That charity is not listed. <Link to="/charities">Browse all charities</Link>.
        </p>
      </section>
    );
  if (load.status === 'error')
    return <p role="alert">This charity could not be loaded. Please try again.</p>;

  const { charity } = load;
  return (
    <article>
      <h1>{charity.name}</h1>
      {charity.tags.length > 0 && <p>Tags: {charity.tags.join(', ')}</p>}
      {charity.images.map((image) => (
        <img key={image.id} src={image.url} alt={image.altText} width={320} />
      ))}
      <p>{charity.description}</p>

      <h2>Upcoming events</h2>
      {charity.upcomingEvents.length === 0 ? (
        <p>No upcoming events.</p>
      ) : (
        <ul aria-label="Upcoming events">
          {charity.upcomingEvents.map((event) => (
            <li key={event.id}>
              <strong>{event.title}</strong> —{' '}
              <time dateTime={event.startsAt}>{formatDateTime(event.startsAt)}</time>
              {event.location && <> · {event.location}</>}
              {event.description && <p>{event.description}</p>}
            </li>
          ))}
        </ul>
      )}

      {/* A visitor's choice is carried into signup (CHR-01); a signed-in user goes to change theirs. Nothing is
          offered while the sign-in state is still being resolved, so a signed-in user is never sent to signup. */}
      {auth.status === 'authenticated' && (
        <p>
          <Link to={`/account/charity?charity=${charity.id}`}>Choose this charity</Link>
        </p>
      )}
      {auth.status === 'unauthenticated' && (
        <p>
          <Link to={`/signup?charity=${charity.id}`}>Choose this charity</Link>
        </p>
      )}
    </article>
  );
}
