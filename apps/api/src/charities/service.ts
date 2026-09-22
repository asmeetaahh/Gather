import {
  AUTH_ERROR_CODES,
  CHARITY_ERROR_CODES,
  MIN_CHARITY_BPS,
  checkCharityPercentage,
  type AdminCharityDto,
  type CharityDetailDto,
  type CharityListQuery,
  type CharityPreferenceDto,
  type CharitySummaryDto,
  type ContributionTotalDto,
  type CreateCharityRequest,
  type ListCharitiesResponse,
  type ListContributionsResponse,
  type UpdateCharityPreferenceRequest,
  type UpdateCharityRequest,
} from '@gather/shared';
import { AppError } from '../errors.js';
import type { CharityRepository, StoredPreference } from './repository.js';

/** How many featured charities the homepage spotlight returns. One or several is undecided (D-033); a small cap. */
export const CHARITY_SPOTLIGHT_LIMIT = 6;

export interface CharityService {
  list(query: CharityListQuery): Promise<ListCharitiesResponse>;
  detail(slug: string): Promise<CharityDetailDto>;
  spotlight(): Promise<CharitySummaryDto[]>;
  getPreference(userId: string): Promise<CharityPreferenceDto>;
  updatePreference(
    userId: string,
    request: UpdateCharityPreferenceRequest,
  ): Promise<CharityPreferenceDto>;
  /**
   * The precondition for starting a subscription (CHR-01, D-065): the user must have a selected charity that is
   * still listed. Throws `422 charity_required` / `422 selected_charity_unavailable` otherwise; on success returns
   * the charity the contribution will go to. Phase 5's checkout must call this BEFORE creating any payment.
   */
  requireSubscribableCharity(userId: string): Promise<SubscribableCharity>;
  listContributions(userId: string): Promise<ListContributionsResponse>;

  // ---- Admin (PRD §11 ADM-05) -------------------------------------------------------------------
  /** Every charity, listed or archived (only the admin view includes archived ones). */
  adminList(): Promise<AdminCharityDto[]>;
  adminDetail(id: string): Promise<AdminCharityDto>;
  create(input: CreateCharityRequest): Promise<AdminCharityDto>;
  update(id: string, patch: UpdateCharityRequest): Promise<AdminCharityDto>;
  archive(id: string): Promise<AdminCharityDto>;
  unarchive(id: string): Promise<AdminCharityDto>;
}

export interface CharityServiceDeps {
  repository: CharityRepository;
  /** Injected clock: "upcoming" is relative to it. */
  now?: () => Date;
}

/** What a subscription may proceed with: the user's current (listed) charity and chosen percentage. */
export interface SubscribableCharity {
  charityId: string;
  percentageBps: number;
}

const notFound = () =>
  new AppError(404, CHARITY_ERROR_CODES.notFound, 'That charity was not found.');
const profileMissing = () =>
  new AppError(
    403,
    AUTH_ERROR_CODES.profileMissing,
    'Your account is not set up yet. Please contact support.',
  );
const unavailable = () =>
  new AppError(
    422,
    CHARITY_ERROR_CODES.unavailable,
    'That charity is no longer available to select.',
  );

function toPreferenceDto(stored: StoredPreference, maxBps: number | null): CharityPreferenceDto {
  return {
    charity: stored.charity,
    percentageBps: stored.percentageBps,
    minBps: MIN_CHARITY_BPS,
    maxBps,
  };
}

/** Sums contributions per currency with integer arithmetic; currencies are never mixed. */
export function totalsByCurrency(
  contributions: { currency: string; amountMinor: number }[],
): ContributionTotalDto[] {
  const totals = new Map<string, number>();
  for (const { currency, amountMinor } of contributions) {
    const sum = (totals.get(currency) ?? 0) + amountMinor;
    if (!Number.isSafeInteger(sum))
      throw new Error('Contribution total exceeds the safe integer range');
    totals.set(currency, sum);
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

/**
 * Charity use-cases (PRD §08).
 *
 * ACCESS. The directory, profiles and spotlight are PUBLIC (PRD §03: visitors explore listed charities).
 * Choosing a charity and a percentage needs a signed-in user but NOT a subscription: the charity is chosen
 * "at signup" (CHR-01), which happens before anyone can subscribe. Every user-scoped call receives the id of
 * the verified caller, never anything from a request.
 *
 * PERCENTAGE. Any value from the PRD minimum (10%) up to 100% — or the configured product cap — is valid at
 * any time, so a user can raise OR lower it (owner decision D-064). No amounts are computed here: gross/net
 * basis and rounding are still open (D-025) and belong with payments.
 */
export function createCharityService({
  repository,
  now = () => new Date(),
}: CharityServiceDeps): CharityService {
  return {
    async list(query) {
      const { charities, hasMore } = await repository.list(query, now().toISOString());
      return { charities, limit: query.limit, offset: query.offset, hasMore };
    },

    async detail(slug) {
      const charity = await repository.findBySlug(slug, now().toISOString());
      if (!charity) throw notFound();
      return charity;
    },

    async spotlight() {
      const { charities } = await repository.list(
        { featured: true, limit: CHARITY_SPOTLIGHT_LIMIT, offset: 0 },
        now().toISOString(),
      );
      return charities;
    },

    async getPreference(userId) {
      const [stored, maxBps] = await Promise.all([
        repository.getPreference(userId),
        repository.getMaxBps(),
      ]);
      if (!stored) throw profileMissing();
      return toPreferenceDto(stored, maxBps);
    },

    async updatePreference(userId, request) {
      const maxBps = await repository.getMaxBps();

      // Validate EVERYTHING before writing anything.
      if (request.percentageBps !== undefined) {
        const check = checkCharityPercentage(request.percentageBps, maxBps);
        if (!check.ok) {
          const code =
            check.problem === 'below_minimum'
              ? CHARITY_ERROR_CODES.percentageBelowMinimum
              : CHARITY_ERROR_CODES.percentageAboveMaximum;
          throw new AppError(422, code, check.message);
        }
      }
      if (request.charityId !== undefined) {
        const charity = await repository.findForSelection(request.charityId);
        if (!charity) throw notFound();
        if (charity.archived) throw unavailable();
      }

      const result = await repository.updatePreference(userId, request);
      switch (result.kind) {
        case 'updated':
          return toPreferenceDto(result.preference, maxBps);
        // The check above and the write are separate statements: the database guard covers the gap.
        case 'charity_unavailable':
          throw unavailable();
        case 'charity_not_found':
          throw notFound();
        case 'no_profile':
          throw profileMissing();
      }
    },

    async requireSubscribableCharity(userId) {
      const stored = await repository.getPreference(userId);
      if (!stored) throw profileMissing();
      if (!stored.charity) {
        throw new AppError(
          422,
          CHARITY_ERROR_CODES.selectionRequired,
          'Choose a charity before you subscribe.',
        );
      }
      // Archived after it was chosen: the user must replace it first (D-065). Never fall back to another charity.
      if (stored.charity.isArchived) {
        throw new AppError(
          422,
          CHARITY_ERROR_CODES.selectedUnavailable,
          'Your selected charity is no longer available. Choose another charity before you subscribe.',
        );
      }
      return { charityId: stored.charity.id, percentageBps: stored.percentageBps };
    },

    async listContributions(userId) {
      const contributions = await repository.listContributions(userId);
      return { contributions, totals: totalsByCurrency(contributions) };
    },

    // ---- Admin (ADM-05) ---------------------------------------------------------------------------

    async adminList() {
      return repository.adminList(now().toISOString());
    },

    async adminDetail(id) {
      const charity = await repository.adminFindById(id, now().toISOString());
      if (!charity) throw notFound();
      return charity;
    },

    async create(input) {
      const result = await repository.create(input);
      if (result.kind === 'duplicate_slug') {
        throw new AppError(
          409,
          CHARITY_ERROR_CODES.duplicateSlug,
          'A charity with that slug already exists.',
        );
      }
      return result.charity;
    },

    async update(id, patch) {
      const charity = await repository.update(id, patch, now().toISOString());
      if (!charity) throw notFound();
      return charity;
    },

    async archive(id) {
      const charity = await repository.setArchived(id, true, now().toISOString());
      if (!charity) throw notFound();
      return charity;
    },

    async unarchive(id) {
      const charity = await repository.setArchived(id, false, now().toISOString());
      if (!charity) throw notFound();
      return charity;
    },
  };
}
