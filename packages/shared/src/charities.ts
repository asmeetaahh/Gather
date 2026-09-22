import { BPS_DENOMINATOR, MIN_CHARITY_BPS } from './domain.js';
import type { PaymentKind } from './enums.js';
import type { FieldError } from './errors.js';
import type { Parsed } from './scores.js';

// ---- Paths ---------------------------------------------------------------------------------------

/** Public charity directory: `GET /api/charities` and `GET /api/charities/:slug`. No sign-in needed (PRD §03). */
export const API_CHARITIES_PATH = '/api/charities' as const;
/** Homepage spotlight (PRD §08 "featured charity section"): `GET /api/charity-spotlight`. Public. */
export const API_CHARITY_SPOTLIGHT_PATH = '/api/charity-spotlight' as const;
/** The signed-in user's selected charity and contribution percentage. */
export const API_MY_CHARITY_PATH = '/api/me/charity' as const;
/** The signed-in user's own charity contributions (read-only). */
export const API_MY_CONTRIBUTIONS_PATH = '/api/me/contributions' as const;

// ---- Public content ------------------------------------------------------------------------------

export interface CharityImageDto {
  id: string;
  /** Public URL of the image in the `charity-media` bucket. */
  url: string;
  altText: string;
}

export interface CharityEventDto {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO-8601 instant. */
  startsAt: string;
  endsAt: string | null;
}

/** A charity as shown in the directory and the homepage spotlight. */
export interface CharitySummaryDto {
  id: string;
  slug: string;
  name: string;
  /** The start of the description, cut at a word boundary. */
  summary: string;
  tags: string[];
  isFeatured: boolean;
  /** The first image, or `null`. */
  coverImage: CharityImageDto | null;
  /** Start of the soonest upcoming event, or `null`. */
  nextEventAt: string | null;
}

/** A charity's full public profile (PRD §08: description, images, upcoming events). */
export interface CharityDetailDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  isFeatured: boolean;
  images: CharityImageDto[];
  /** Events starting now or later, soonest first. */
  upcomingEvents: CharityEventDto[];
}

export interface ListCharitiesResponse {
  charities: CharitySummaryDto[];
  limit: number;
  offset: number;
  /** True when more results exist after this page. */
  hasMore: boolean;
}

export interface CharityDetailResponse {
  charity: CharityDetailDto;
}

export interface CharitySpotlightResponse {
  charities: CharitySummaryDto[];
}

// ---- The signed-in user's choice ----------------------------------------------------------------

export interface CharityPreferenceDto {
  /** The selected charity, or `null` if none yet. `isArchived` when it has since been removed from the directory. */
  charity: { id: string; slug: string; name: string; isArchived: boolean } | null;
  /** Share of the subscription fee going to the charity, in basis points (1000 = 10%). */
  percentageBps: number;
  /** The PRD minimum (10%). */
  minBps: number;
  /** A configured product cap, or `null` for none beyond 100%. */
  maxBps: number | null;
}

export interface CharityPreferenceResponse {
  preference: CharityPreferenceDto;
}

/** `PATCH /api/me/charity` — send either field or both. */
export interface UpdateCharityPreferenceRequest {
  charityId?: string;
  percentageBps?: number;
}

/** A charity contribution recorded for the user (a share of a subscription payment, or a donation). */
export interface ContributionDto {
  id: string;
  charityId: string;
  charityName: string;
  source: PaymentKind;
  /** Integer minor units of `currency`. */
  amountMinor: number;
  currency: string;
  /** Subscription contributions only: the percentage that was applied. */
  percentageBps: number | null;
  /** Subscription contributions only: the fee the percentage was applied to. */
  basisMinor: number | null;
  createdAt: string;
}

export interface ContributionTotalDto {
  currency: string;
  amountMinor: number;
}

export interface ListContributionsResponse {
  contributions: ContributionDto[];
  /** Sum per currency (amounts in different currencies are never added together). */
  totals: ContributionTotalDto[];
}

/**
 * A request to make an independent donation (PRD §08, CHR-04). Executing the payment is a later phase; this
 * defines and validates the request so that phase has a single contract.
 */
export interface DonationRequest {
  charityId: string;
  /** Integer minor units, at least 1. No minimum is defined by the PRD (DECISIONS D-025). */
  amountMinor: number;
  /** Three capital letters. Which currencies are accepted is undecided (D-024). */
  currency: string;
}

/** Stable `error.code` values for charity endpoints. */
export const CHARITY_ERROR_CODES = {
  /** No listed charity matches. HTTP 404. */
  notFound: 'charity_not_found',
  /** The charity exists but is no longer listed, so it cannot be selected. HTTP 422. */
  unavailable: 'charity_unavailable',
  /** The percentage is below the PRD minimum of 10%. HTTP 422. */
  percentageBelowMinimum: 'percentage_below_minimum',
  /** The percentage is above the configured maximum (or 100%). HTTP 422. */
  percentageAboveMaximum: 'percentage_above_maximum',
  /** Subscribing needs a selected charity and the user has none (CHR-01, D-065). HTTP 422. */
  selectionRequired: 'charity_required',
  /** The user's selected charity was archived: they must choose another before subscribing (D-065). HTTP 422. */
  selectedUnavailable: 'selected_charity_unavailable',
} as const;

/**
 * The signup-data key that carries the charity chosen on the signup form (CHR-01). Sent with
 * `auth.signUp({ options: { data: { [SIGNUP_CHARITY_METADATA_KEY]: charityId } } })` and read — as untrusted
 * input, validated in SQL — by the `handle_new_user()` trigger (migration `…130000_signup_charity_selection`).
 */
export const SIGNUP_CHARITY_METADATA_KEY = 'selected_charity_id';

// ---- Directory query -----------------------------------------------------------------------------

export const CHARITY_LIST_DEFAULT_LIMIT = 20;
export const CHARITY_LIST_MAX_LIMIT = 50;
export const CHARITY_SEARCH_MAX_LENGTH = 100;
export const CHARITY_TAG_MAX_LENGTH = 40;
const MAX_OFFSET = 10_000;

export interface CharityListQuery {
  /** Free-text search over name and description. */
  q?: string;
  /** Exact tag (lower-case). */
  tag?: string;
  /** Only `true` is supported: restrict to featured charities. */
  featured?: true;
  limit: number;
  offset: number;
}

const TAG_SHAPE = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;
const DIGITS = /^\d+$/;

/** Same shape the database enforces on `charities.slug`. */
export function isValidCharitySlug(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 200
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

/**
 * Validates the directory query string (PRD §08 "search and filter"). Filter dimensions are provisional
 * (DECISIONS D-033): text search, one tag, and featured-only. Every value must be a single string.
 */
export function parseCharityListQuery(query: Record<string, unknown>): Parsed<CharityListQuery> {
  const errors: FieldError[] = [];
  const single = (field: string): string | undefined => {
    const value = query[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      errors.push({ field, message: 'Provide a single value.' });
      return undefined;
    }
    return value;
  };

  const result: CharityListQuery = { limit: CHARITY_LIST_DEFAULT_LIMIT, offset: 0 };

  const q = single('q')?.trim();
  if (q) {
    if (q.length > CHARITY_SEARCH_MAX_LENGTH) {
      errors.push({
        field: 'q',
        message: `Search text can be at most ${String(CHARITY_SEARCH_MAX_LENGTH)} characters.`,
      });
    } else {
      result.q = q;
    }
  }

  const tag = single('tag')?.trim().toLowerCase();
  if (tag) {
    if (tag.length > CHARITY_TAG_MAX_LENGTH || !TAG_SHAPE.test(tag)) {
      errors.push({
        field: 'tag',
        message: 'A tag uses letters, numbers, spaces and hyphens only.',
      });
    } else {
      result.tag = tag;
    }
  }

  const featured = single('featured');
  if (featured !== undefined && featured !== '') {
    if (featured === 'true') result.featured = true;
    else errors.push({ field: 'featured', message: 'Only featured=true is supported.' });
  }

  const limit = single('limit');
  if (limit !== undefined && limit !== '') {
    const n = DIGITS.test(limit) ? Number(limit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > CHARITY_LIST_MAX_LIMIT) {
      errors.push({
        field: 'limit',
        message: `limit must be a whole number from 1 to ${String(CHARITY_LIST_MAX_LIMIT)}.`,
      });
    } else {
      result.limit = n;
    }
  }

  const offset = single('offset');
  if (offset !== undefined && offset !== '') {
    const n = DIGITS.test(offset) ? Number(offset) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) {
      errors.push({
        field: 'offset',
        message: `offset must be a whole number from 0 to ${String(MAX_OFFSET)}.`,
      });
    } else {
      result.offset = n;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: result };
}

// ---- Contribution percentage ---------------------------------------------------------------------

/** Formats basis points as a percentage: 1000 → "10%", 1250 → "12.5%", 1005 → "10.05%". */
export function formatPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return `${String(whole)}%`;
  return `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

/**
 * Converts what a person types ("12.5", "10") into basis points (1250, 1000). Accepts up to two decimals;
 * returns `null` for anything else (letters, negatives, "1e2", three decimals, more than three digits).
 * Done with string arithmetic so no floating-point error can creep into a percentage.
 */
export function percentToBps(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100 + fraction;
}

export type PercentageCheck =
  | { ok: true; bps: number }
  | { ok: false; problem: 'not_an_integer' | 'below_minimum' | 'above_maximum'; message: string };

/**
 * Validates a contribution percentage in basis points (PRD §08, CHR-02/03, D-064):
 *  - an integer;
 *  - at least the PRD minimum, 10% — the only hard product rule;
 *  - at most 100%, and at most `maxBps` when a product cap is configured (D-025; `null` = no cap).
 * There is no "increase only" rule: any value in range is valid whatever the current one is (D-064).
 */
export function checkCharityPercentage(
  value: unknown,
  maxBps: number | null = null,
): PercentageCheck {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return {
      ok: false,
      problem: 'not_an_integer',
      message: 'The percentage must be a whole number of basis points.',
    };
  }
  if (value < MIN_CHARITY_BPS) {
    return {
      ok: false,
      problem: 'below_minimum',
      message: `The charity contribution must be at least ${formatPercent(MIN_CHARITY_BPS)}.`,
    };
  }
  const ceiling = Math.min(BPS_DENOMINATOR, maxBps ?? BPS_DENOMINATOR);
  if (value > ceiling) {
    return {
      ok: false,
      problem: 'above_maximum',
      message: `The charity contribution cannot be more than ${formatPercent(ceiling)}.`,
    };
  }
  return { ok: true, bps: value };
}

// ---- Request bodies ------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const bodyError = (): Parsed<never> => ({
  ok: false,
  errors: [{ field: 'body', message: 'A JSON object is required.' }],
});

/**
 * Validates `PATCH /api/me/charity`. Only `charityId` and `percentageBps` are read (anything else, such as a
 * `userId`, is ignored). At least one must be present. Range rules for the percentage are applied separately
 * with `checkCharityPercentage`, because they depend on server configuration.
 */
export function parseUpdateCharityPreference(
  body: unknown,
): Parsed<UpdateCharityPreferenceRequest> {
  if (!isPlainObject(body)) return bodyError();
  const errors: FieldError[] = [];
  const value: UpdateCharityPreferenceRequest = {};

  if (body.charityId !== undefined) {
    if (isUuid(body.charityId)) value.charityId = body.charityId;
    else errors.push({ field: 'charityId', message: 'charityId must be a charity id.' });
  }
  if (body.percentageBps !== undefined) {
    if (typeof body.percentageBps === 'number' && Number.isInteger(body.percentageBps)) {
      value.percentageBps = body.percentageBps;
    } else {
      errors.push({ field: 'percentageBps', message: 'percentageBps must be a whole number.' });
    }
  }
  if (errors.length === 0 && value.charityId === undefined && value.percentageBps === undefined) {
    errors.push({ field: 'body', message: 'Provide charityId and/or percentageBps.' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Validates an independent-donation request (used by the payment phase). */
export function parseDonationRequest(body: unknown): Parsed<DonationRequest> {
  if (!isPlainObject(body)) return bodyError();
  const errors: FieldError[] = [];
  if (!isUuid(body.charityId))
    errors.push({ field: 'charityId', message: 'charityId must be a charity id.' });
  const amount = body.amountMinor;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
    errors.push({
      field: 'amountMinor',
      message: 'The amount must be a whole number of minor units, at least 1.',
    });
  }
  if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) {
    errors.push({
      field: 'currency',
      message: 'The currency must be a three-letter ISO 4217 code, in capitals.',
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      charityId: body.charityId as string,
      amountMinor: amount as number,
      currency: body.currency as string,
    },
  };
}
