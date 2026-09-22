import { useEffect, useState } from 'react';
import type { CharitySummaryDto } from '@gather/shared';
import { fetchCharitySpotlight } from '../api/charities';
import { CharitySummaryItem } from './CharitySummaryItem';

/**
 * Homepage spotlight (PRD §08): featured charities. It is a supporting element, so if it cannot load —
 * or nothing is featured — it simply renders nothing rather than putting an error on the homepage.
 */
export function CharitySpotlight() {
  const [charities, setCharities] = useState<CharitySummaryDto[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetchCharitySpotlight(controller.signal)
      .then((body) => {
        setCharities(body.charities);
      })
      .catch(() => {
        /* nothing featured, or unavailable: show nothing */
      });
    return () => {
      controller.abort();
    };
  }, []);

  if (charities.length === 0) return null;
  return (
    <section aria-labelledby="spotlight-heading">
      <h2 id="spotlight-heading">Charity spotlight</h2>
      <ul aria-label="Featured charities">
        {charities.map((charity) => (
          <CharitySummaryItem key={charity.id} charity={charity} headingLevel={3} />
        ))}
      </ul>
    </section>
  );
}
