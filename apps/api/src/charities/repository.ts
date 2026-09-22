import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CharityDetailDto,
  CharityEventDto,
  CharityImageDto,
  CharityListQuery,
  CharitySummaryDto,
  ContributionDto,
} from '@gather/shared';
import { summarize, toPrefixTsQuery } from './text.js';

/** The user's stored charity choice. */
export interface StoredPreference {
  percentageBps: number;
  charity: { id: string; slug: string; name: string; isArchived: boolean } | null;
}

export type UpdatePreferenceResult =
  | { kind: 'updated'; preference: StoredPreference }
  /** The charity id does not exist. */
  | { kind: 'charity_not_found' }
  /** The charity exists but is archived (database guard, SQLSTATE GS002). */
  | { kind: 'charity_unavailable' }
  /** There is no profile row for the user. */
  | { kind: 'no_profile' };

/**
 * Persistence for the charity domain. Public reads (directory, detail, spotlight) return ONLY listed
 * (non-archived) charities; that filter is applied here explicitly because the service role bypasses RLS.
 * User-scoped methods take the user id explicitly and scope every query by it.
 */
export interface CharityRepository {
  /** Listed charities matching the filters, by name; `hasMore` says whether another page exists. */
  list(
    filter: CharityListQuery,
    nowIso: string,
  ): Promise<{ charities: CharitySummaryDto[]; hasMore: boolean }>;
  /** A listed charity's full profile, or `null` (unknown slug or archived). */
  findBySlug(slug: string, nowIso: string): Promise<CharityDetailDto | null>;
  /** Whether a charity exists and whether it is archived — for validating a selection. */
  findForSelection(id: string): Promise<{ id: string; archived: boolean } | null>;
  getPreference(userId: string): Promise<StoredPreference | null>;
  updatePreference(
    userId: string,
    patch: { charityId?: string; percentageBps?: number },
  ): Promise<UpdatePreferenceResult>;
  /** The configured product cap on the percentage (`platform_settings.charity_max_bps`), or `null`. */
  getMaxBps(): Promise<number | null>;
  /** The user's own contributions, newest first. */
  listContributions(userId: string): Promise<ContributionDto[]>;
}

// ---- Row parsing (the trust boundary with PostgREST) ---------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`Malformed ${what}`);
  return v;
};
const strOrNull = (v: unknown, what: string): string | null => (v === null ? null : str(v, what));
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`Malformed ${what}`);
  return v as unknown[];
};

interface ImageRow {
  id: string;
  storagePath: string;
  altText: string;
  sortOrder: number;
}

export interface CharityRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  isFeatured: boolean;
  images: ImageRow[];
  events: CharityEventDto[];
}

function parseImage(row: unknown): ImageRow {
  if (!isRecord(row)) throw new Error('Malformed charity image');
  const sortOrder = row.sort_order;
  if (typeof sortOrder !== 'number') throw new Error('Malformed charity image');
  return {
    id: str(row.id, 'charity image'),
    storagePath: str(row.storage_path, 'charity image'),
    altText: str(row.alt_text, 'charity image'),
    sortOrder,
  };
}

function parseEvent(row: unknown): CharityEventDto {
  if (!isRecord(row)) throw new Error('Malformed charity event');
  return {
    id: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title : '',
    description: row.description === undefined ? null : strOrNull(row.description, 'charity event'),
    location: row.location === undefined ? null : strOrNull(row.location, 'charity event'),
    startsAt: str(row.starts_at, 'charity event'),
    endsAt: row.ends_at === undefined ? null : strOrNull(row.ends_at, 'charity event'),
  };
}

/** Validates a `charities` row with its embedded images and events. */
export function parseCharityRow(row: unknown): CharityRow {
  if (!isRecord(row)) throw new Error('Malformed charity row');
  const tags = arr(row.tags, 'charity tags');
  if (!tags.every((t) => typeof t === 'string')) throw new Error('Malformed charity tags');
  if (typeof row.is_featured !== 'boolean') throw new Error('Malformed charity row');
  return {
    id: str(row.id, 'charity row'),
    slug: str(row.slug, 'charity row'),
    name: str(row.name, 'charity row'),
    description: str(row.description, 'charity row'),
    tags,
    isFeatured: row.is_featured,
    images: arr(row.charity_images ?? [], 'charity images').map(parseImage),
    events: arr(row.charity_events ?? [], 'charity events').map(parseEvent),
  };
}

const byPosition = (a: ImageRow, b: ImageRow) =>
  a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);

export type ImageUrl = (storagePath: string) => string;

const toImage = (image: ImageRow, url: ImageUrl): CharityImageDto => ({
  id: image.id,
  url: url(image.storagePath),
  altText: image.altText,
});

/** Directory/spotlight card: the description is shortened, only the FIRST image is used, and the soonest event date. */
export function toSummary(row: CharityRow, url: ImageUrl): CharitySummaryDto {
  const cover = [...row.images].sort(byPosition)[0];
  const starts = row.events.map((e) => e.startsAt).sort();
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: summarize(row.description),
    tags: row.tags,
    isFeatured: row.isFeatured,
    coverImage: cover ? toImage(cover, url) : null,
    nextEventAt: starts[0] ?? null,
  };
}

/** Full profile: every image in order, upcoming events soonest first. */
export function toDetail(row: CharityRow, url: ImageUrl): CharityDetailDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    isFeatured: row.isFeatured,
    images: [...row.images].sort(byPosition).map((image) => toImage(image, url)),
    upcomingEvents: [...row.events].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  };
}

function parsePreference(row: unknown): StoredPreference {
  if (!isRecord(row)) throw new Error('Malformed profile row');
  const bps = row.charity_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps)) throw new Error('Malformed profile row');
  const c = row.charities;
  if (c === null || c === undefined) return { percentageBps: bps, charity: null };
  if (!isRecord(c)) throw new Error('Malformed profile row');
  return {
    percentageBps: bps,
    charity: {
      id: str(c.id, 'charity'),
      slug: str(c.slug, 'charity'),
      name: str(c.name, 'charity'),
      isArchived: c.archived_at !== null && c.archived_at !== undefined,
    },
  };
}

function parseContribution(row: unknown): ContributionDto {
  if (!isRecord(row)) throw new Error('Malformed contribution row');
  const num = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v))
      throw new Error('Malformed contribution row');
    return v;
  };
  const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
  const source = row.source;
  if (source !== 'subscription' && source !== 'donation')
    throw new Error('Malformed contribution row');
  const charity = row.charities;
  return {
    id: str(row.id, 'contribution'),
    charityId: str(row.charity_id, 'contribution'),
    charityName: isRecord(charity) ? str(charity.name, 'contribution') : '',
    source,
    amountMinor: num(row.amount_minor),
    currency: str(row.currency, 'contribution'),
    percentageBps: numOrNull(row.percentage_bps),
    basisMinor: numOrNull(row.basis_minor),
    createdAt: str(row.created_at, 'contribution'),
  };
}

/** SQLSTATEs the API maps to business outcomes. */
const CHARITY_ARCHIVED = 'GS002'; // raised by the enforce_selectable_charity trigger
const FOREIGN_KEY_VIOLATION = '23503';

const LIST_SELECT =
  'id, slug, name, description, tags, is_featured, charity_images(id, storage_path, alt_text, sort_order), charity_events(starts_at)';
const DETAIL_SELECT =
  'id, slug, name, description, tags, is_featured, charity_images(id, storage_path, alt_text, sort_order), charity_events(id, title, description, location, starts_at, ends_at)';
const PREFERENCE_SELECT = 'charity_bps, charities!selected_charity_id(id, slug, name, archived_at)';
const MAX_EVENTS = 20;
const MAX_CONTRIBUTIONS = 100;

/** Supabase-backed repository, using the service-role client (server-side only). */
export function createSupabaseCharityRepository(client: SupabaseClient): CharityRepository {
  const url: ImageUrl = (path) =>
    client.storage.from('charity-media').getPublicUrl(path).data.publicUrl;

  return {
    async list(filter, nowIso) {
      // Text with no searchable word ("!!!") matches nothing, rather than everything — decided before any
      // database work.
      let tsquery: string | null = null;
      if (filter.q !== undefined) {
        tsquery = toPrefixTsQuery(filter.q);
        if (tsquery === null) return { charities: [], hasMore: false };
      }

      let query = client
        .from('charities')
        .select(LIST_SELECT)
        .is('archived_at', null) // only LISTED charities ever leave this repository
        .gte('charity_events.starts_at', nowIso) // embedded events: upcoming only
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .order('sort_order', { referencedTable: 'charity_images', ascending: true });

      if (filter.featured) query = query.eq('is_featured', true);
      if (filter.tag) query = query.contains('tags', [filter.tag]);
      if (tsquery !== null) query = query.textSearch('search', tsquery, { config: 'english' });

      // One extra row tells us whether another page exists, without a separate count query.
      const { data, error } = await query.range(filter.offset, filter.offset + filter.limit);
      if (error) throw new Error(`Charity list failed: ${error.message}`);
      const rows = (data as unknown[]).map(parseCharityRow);
      return {
        charities: rows.slice(0, filter.limit).map((r) => toSummary(r, url)),
        hasMore: rows.length > filter.limit,
      };
    },

    async findBySlug(slug, nowIso) {
      const { data, error } = await client
        .from('charities')
        .select(DETAIL_SELECT)
        .eq('slug', slug)
        .is('archived_at', null)
        .gte('charity_events.starts_at', nowIso)
        .order('starts_at', { referencedTable: 'charity_events', ascending: true })
        .limit(MAX_EVENTS, { referencedTable: 'charity_events' })
        .order('sort_order', { referencedTable: 'charity_images', ascending: true })
        .maybeSingle();
      if (error) throw new Error(`Charity lookup failed: ${error.message}`);
      return data === null ? null : toDetail(parseCharityRow(data), url);
    },

    async findForSelection(id) {
      const { data, error } = await client
        .from('charities')
        .select('id, archived_at')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Charity lookup failed: ${error.message}`);
      if (data === null) return null;
      const row = data as Record<string, unknown>;
      return { id: str(row.id, 'charity'), archived: row.archived_at !== null };
    },

    async getPreference(userId) {
      const { data, error } = await client
        .from('profiles')
        .select(PREFERENCE_SELECT)
        .eq('id', userId)
        .maybeSingle();
      if (error) throw new Error(`Preference lookup failed: ${error.message}`);
      return data === null ? null : parsePreference(data);
    },

    async updatePreference(userId, patch) {
      const changes = {
        ...(patch.charityId !== undefined && { selected_charity_id: patch.charityId }),
        ...(patch.percentageBps !== undefined && { charity_bps: patch.percentageBps }),
      };
      const { data, error } = await client
        .from('profiles')
        .update(changes)
        .eq('id', userId)
        .select(PREFERENCE_SELECT)
        .maybeSingle();
      if (error) {
        if (error.code === CHARITY_ARCHIVED) return { kind: 'charity_unavailable' };
        if (error.code === FOREIGN_KEY_VIOLATION) return { kind: 'charity_not_found' };
        throw new Error(`Preference update failed (${error.code}): ${error.message}`);
      }
      return data === null
        ? { kind: 'no_profile' }
        : { kind: 'updated', preference: parsePreference(data) };
    },

    async getMaxBps() {
      const { data, error } = await client
        .from('platform_settings')
        .select('charity_max_bps')
        .eq('id', true)
        .maybeSingle();
      if (error) throw new Error(`Settings lookup failed: ${error.message}`);
      const value = (data as Record<string, unknown> | null)?.charity_max_bps;
      return typeof value === 'number' ? value : null;
    },

    async listContributions(userId) {
      const { data, error } = await client
        .from('charity_contributions')
        .select(
          'id, charity_id, source, currency, amount_minor, basis_minor, percentage_bps, created_at, charities(name)',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(MAX_CONTRIBUTIONS);
      if (error) throw new Error(`Contribution lookup failed: ${error.message}`);
      return (data as unknown[]).map(parseContribution);
    },
  };
}
