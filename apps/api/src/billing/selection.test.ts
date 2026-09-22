import { describe, expect, it } from 'vitest';
import { InMemoryCharities } from '../test-support/charities.js';
import { createCharitySelectionReader } from './selection.js';

describe('createCharitySelectionReader — the user’s current charity for a renewal (D-069)', () => {
  it('returns the selected charity and percentage', async () => {
    const charities = new InMemoryCharities();
    const c = charities.seedCharity({ name: 'Riverside' });
    charities.seedProfile('u', c, 2500);
    expect(await createCharitySelectionReader(charities).current('u')).toEqual({
      charityId: c,
      percentageBps: 2500,
    });
  });
  it('returns the charity EVEN IF it has been archived — archiving hides a charity, it does not erase it (D-043)', async () => {
    const charities = new InMemoryCharities();
    const c = charities.seedCharity({ name: 'Riverside' });
    charities.seedProfile('u', c, 1000);
    charities.archive(c);
    expect(await createCharitySelectionReader(charities).current('u')).toEqual({
      charityId: c,
      percentageBps: 1000,
    });
  });
  it('is null when no charity is selected, and when there is no profile', async () => {
    const charities = new InMemoryCharities();
    charities.seedProfile('u', null);
    expect(await createCharitySelectionReader(charities).current('u')).toBeNull();
    expect(await createCharitySelectionReader(charities).current('ghost')).toBeNull();
  });
});
