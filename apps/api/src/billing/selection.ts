import type { CharityRepository } from '../charities/repository.js';
import type { SelectionReader } from './webhooks.js';

/**
 * Reads the user's current charity choice for the webhook processor. It reads the stored choice EVEN IF that
 * charity has since been archived: archiving hides a charity from the public, it does not make it an invalid
 * recipient for money the user already paid on their own instruction (D-043, D-069).
 */
export function createCharitySelectionReader(
  charities: Pick<CharityRepository, 'getPreference'>,
): SelectionReader {
  return {
    async current(userId) {
      const preference = await charities.getPreference(userId);
      if (!preference?.charity) return null;
      return { charityId: preference.charity.id, percentageBps: preference.percentageBps };
    },
  };
}
