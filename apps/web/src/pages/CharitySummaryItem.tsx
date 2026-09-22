import { Link } from 'react-router-dom';
import type { CharitySummaryDto } from '@gather/shared';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

/** One charity in a list (directory and homepage spotlight). Minimal markup; styling comes later. */
export function CharitySummaryItem({
  charity,
  headingLevel = 2,
}: {
  charity: CharitySummaryDto;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <li>
      <Heading>
        <Link to={`/charities/${charity.slug}`}>{charity.name}</Link>
      </Heading>
      {charity.coverImage && (
        <img src={charity.coverImage.url} alt={charity.coverImage.altText} width={160} />
      )}
      <p>{charity.summary}</p>
      {charity.tags.length > 0 && <p>Tags: {charity.tags.join(', ')}</p>}
      {charity.nextEventAt && (
        <p>
          Next event: <time dateTime={charity.nextEventAt}>{formatDate(charity.nextEventAt)}</time>
        </p>
      )}
    </li>
  );
}
