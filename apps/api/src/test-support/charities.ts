import type {
  AdminCharityDto,
  CharityDetailDto,
  CharityListQuery,
  CharitySummaryDto,
  ContributionDto,
  CreateCharityRequest,
  UpdateCharityRequest,
} from '@gather/shared';
import {
  toDetail,
  toSummary,
  type CharityRepository,
  type CharityRow,
  type CreateCharityResult,
  type StoredPreference,
  type UpdatePreferenceResult,
} from '../charities/repository.js';
import { searchWords } from '../charities/text.js';

/**
 * In-memory charity repository for HTTP/service tests. It applies the same rules the database and the real
 * repository do (listed-only reads, prefix word search, tag containment, upcoming events, the archived-charity
 * selection guard) and reuses the PRODUCTION mapping functions, so DTOs are shaped identically. It is not the
 * authority for search semantics: those are proven on PostgreSQL in supabase/tests/charity.test.ts.
 */
export const imageUrl = (path: string) => `https://cdn.test/charity-media/${path}`;

interface Seed {
  name: string;
  slug?: string;
  description?: string;
  tags?: string[];
  featured?: boolean;
  archived?: boolean;
  images?: { path: string; alt?: string; sortOrder?: number }[];
  events?: {
    title: string;
    startsAt: string;
    endsAt?: string | null;
    location?: string | null;
    description?: string | null;
  }[];
}

export class InMemoryCharities implements CharityRepository {
  private readonly charities: (CharityRow & { archived: boolean })[] = [];
  private readonly profiles = new Map<string, { charityId: string | null; bps: number }>();
  private readonly contributions = new Map<string, ContributionDto[]>();
  private maxBps: number | null = null;
  private nextId = 1;
  readonly calls = {
    list: 0,
    findBySlug: 0,
    findForSelection: 0,
    getPreference: 0,
    updatePreference: 0,
    listContributions: 0,
  };
  failWith: Error | null = null;
  /** The `now` the last read used, so tests can assert the clock was passed through. */
  lastNowIso: string | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  /** UUID-shaped ids, like the database's, so they pass the same request validation real ids do. */
  private id(_kind: 'c' | 'i' | 'e' | 'k'): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }

  seedCharity(seed: Seed): string {
    const id = this.id('c');
    this.charities.push({
      id,
      slug:
        seed.slug ??
        seed.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      name: seed.name,
      description: seed.description ?? `${seed.name} does good work.`,
      tags: seed.tags ?? [],
      isFeatured: seed.featured ?? false,
      archived: seed.archived ?? false,
      images: (seed.images ?? []).map((img, i) => ({
        id: this.id('i'),
        storagePath: img.path,
        altText: img.alt ?? '',
        sortOrder: img.sortOrder ?? i,
      })),
      events: (seed.events ?? []).map((e) => ({
        id: this.id('e'),
        title: e.title,
        description: e.description ?? null,
        location: e.location ?? null,
        startsAt: e.startsAt,
        endsAt: e.endsAt ?? null,
      })),
    });
    return id;
  }

  archive(id: string): void {
    const c = this.charities.find((x) => x.id === id);
    if (c) c.archived = true;
  }

  seedProfile(userId: string, charityId: string | null = null, bps = 1000): void {
    this.profiles.set(userId, { charityId, bps });
  }

  setMaxBps(value: number | null): void {
    this.maxBps = value;
  }

  seedContribution(
    userId: string,
    c: Partial<ContributionDto> & Pick<ContributionDto, 'amountMinor' | 'currency'>,
  ): void {
    const list = this.contributions.get(userId) ?? [];
    list.push({
      id: this.id('k'),
      charityId: 'c-x',
      charityName: 'Some Charity',
      source: 'subscription',
      percentageBps: 1000,
      basisMinor: c.amountMinor * 10,
      createdAt: '2026-01-01T00:00:00Z',
      ...c,
    });
    this.contributions.set(userId, list);
  }

  storedProfile(userId: string) {
    return this.profiles.get(userId);
  }

  private upcoming(row: CharityRow, nowIso: string): CharityRow {
    return { ...row, events: row.events.filter((e) => e.startsAt >= nowIso) };
  }

  list(
    filter: CharityListQuery,
    nowIso: string,
  ): Promise<{ charities: CharitySummaryDto[]; hasMore: boolean }> {
    this.calls.list++;
    this.lastNowIso = nowIso;
    this.guard();
    const words = filter.q === undefined ? null : searchWords(filter.q);
    if (words !== null && words.length === 0)
      return Promise.resolve({ charities: [], hasMore: false });

    const matches = this.charities
      .filter((c) => !c.archived)
      .filter((c) => !filter.featured || c.isFeatured)
      .filter((c) => !filter.tag || c.tags.includes(filter.tag))
      .filter((c) => {
        if (words === null) return true;
        const haystack = searchWords(`${c.name} ${c.description}`, 10_000);
        return words.every((w) => haystack.some((h) => h.startsWith(w)));
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const page = matches.slice(filter.offset, filter.offset + filter.limit);
    return Promise.resolve({
      charities: page.map((c) => toSummary(this.upcoming(c, nowIso), imageUrl)),
      hasMore: matches.length > filter.offset + filter.limit,
    });
  }

  findBySlug(slug: string, nowIso: string): Promise<CharityDetailDto | null> {
    this.calls.findBySlug++;
    this.lastNowIso = nowIso;
    this.guard();
    const c = this.charities.find((x) => x.slug === slug && !x.archived);
    return Promise.resolve(c ? toDetail(this.upcoming(c, nowIso), imageUrl) : null);
  }

  findForSelection(id: string): Promise<{ id: string; archived: boolean } | null> {
    this.calls.findForSelection++;
    this.guard();
    const c = this.charities.find((x) => x.id === id);
    return Promise.resolve(c ? { id: c.id, archived: c.archived } : null);
  }

  private preferenceOf(userId: string): StoredPreference | null {
    const p = this.profiles.get(userId);
    if (!p) return null;
    const c = p.charityId ? this.charities.find((x) => x.id === p.charityId) : undefined;
    return {
      percentageBps: p.bps,
      charity: c ? { id: c.id, slug: c.slug, name: c.name, isArchived: c.archived } : null,
    };
  }

  getPreference(userId: string): Promise<StoredPreference | null> {
    this.calls.getPreference++;
    this.guard();
    return Promise.resolve(this.preferenceOf(userId));
  }

  updatePreference(
    userId: string,
    patch: { charityId?: string; percentageBps?: number },
  ): Promise<UpdatePreferenceResult> {
    this.calls.updatePreference++;
    this.guard();
    const p = this.profiles.get(userId);
    if (!p) return Promise.resolve({ kind: 'no_profile' });
    if (patch.charityId !== undefined && patch.charityId !== p.charityId) {
      const c = this.charities.find((x) => x.id === patch.charityId);
      if (!c) return Promise.resolve({ kind: 'charity_not_found' });
      if (c.archived) return Promise.resolve({ kind: 'charity_unavailable' }); // the database guard (GS002)
    }
    if (patch.charityId !== undefined) p.charityId = patch.charityId;
    if (patch.percentageBps !== undefined) p.bps = patch.percentageBps;
    const preference = this.preferenceOf(userId);
    if (!preference) throw new Error('unreachable');
    return Promise.resolve({ kind: 'updated', preference });
  }

  getMaxBps(): Promise<number | null> {
    this.guard();
    return Promise.resolve(this.maxBps);
  }

  listContributions(userId: string): Promise<ContributionDto[]> {
    this.calls.listContributions++;
    this.guard();
    return Promise.resolve(
      [...(this.contributions.get(userId) ?? [])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
  }

  // ---- Admin (ADM-05) -----------------------------------------------------------------------------
  private toAdmin(row: CharityRow & { archived: boolean }, nowIso: string): AdminCharityDto {
    return { ...toDetail(this.upcoming(row, nowIso), imageUrl), isArchived: row.archived };
  }

  adminList(nowIso: string): Promise<AdminCharityDto[]> {
    this.guard();
    return Promise.resolve(
      [...this.charities]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((c) => this.toAdmin(c, nowIso)),
    );
  }

  adminFindById(id: string, nowIso: string): Promise<AdminCharityDto | null> {
    this.guard();
    const c = this.charities.find((x) => x.id === id);
    return Promise.resolve(c ? this.toAdmin(c, nowIso) : null);
  }

  create(input: CreateCharityRequest): Promise<CreateCharityResult> {
    this.guard();
    if (this.charities.some((c) => c.slug === input.slug)) {
      return Promise.resolve({ kind: 'duplicate_slug' });
    }
    const id = this.seedCharity({
      slug: input.slug,
      name: input.name,
      description: input.description,
      ...(input.tags !== undefined && { tags: input.tags }),
    });
    const c = this.charities.find((x) => x.id === id);
    if (!c) throw new Error('unreachable');
    return Promise.resolve({
      kind: 'created',
      charity: this.toAdmin(c, new Date(0).toISOString()),
    });
  }

  update(id: string, patch: UpdateCharityRequest, nowIso: string): Promise<AdminCharityDto | null> {
    this.guard();
    const c = this.charities.find((x) => x.id === id);
    if (!c) return Promise.resolve(null);
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.description !== undefined) c.description = patch.description;
    if (patch.tags !== undefined) c.tags = patch.tags;
    if (patch.isFeatured !== undefined) c.isFeatured = patch.isFeatured;
    return Promise.resolve(this.toAdmin(c, nowIso));
  }

  setArchived(id: string, archived: boolean, nowIso: string): Promise<AdminCharityDto | null> {
    this.guard();
    const c = this.charities.find((x) => x.id === id);
    if (!c) return Promise.resolve(null);
    c.archived = archived;
    return Promise.resolve(this.toAdmin(c, nowIso));
  }
}
