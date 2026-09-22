import { beforeEach, describe, expect, it } from 'vitest';
import { CHARITY_ERROR_CODES, AUTH_ERROR_CODES } from '@gather/shared';
import { AppError } from '../errors.js';
import { InMemoryCharities } from '../test-support/charities.js';
import { CHARITY_SPOTLIGHT_LIMIT, createCharityService, totalsByCurrency } from './service.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');
const U = 'user-1';
const V = 'user-2';

let repo: InMemoryCharities;
let service: ReturnType<typeof createCharityService>;

beforeEach(() => {
  repo = new InMemoryCharities();
  service = createCharityService({ repository: repo, now: () => NOW });
});

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected the call to be rejected');
}

describe('directory (DIR-01)', () => {
  it('echoes the paging it applied and passes the clock through', async () => {
    repo.seedCharity({ name: 'A' });
    const res = await service.list({ limit: 10, offset: 0 });
    expect(res).toMatchObject({ limit: 10, offset: 0, hasMore: false });
    expect(res.charities).toHaveLength(1);
    expect(repo.lastNowIso).toBe(NOW.toISOString());
  });

  it('pages by name and reports hasMore', async () => {
    for (const n of ['Delta', 'Alpha', 'Charlie', 'Bravo']) repo.seedCharity({ name: n });
    const first = await service.list({ limit: 3, offset: 0 });
    expect(first.charities.map((c) => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(first.hasMore).toBe(true);
    const second = await service.list({ limit: 3, offset: 3 });
    expect(second.charities.map((c) => c.name)).toEqual(['Delta']);
    expect(second.hasMore).toBe(false);
  });

  it('never returns archived charities', async () => {
    repo.seedCharity({ name: 'Listed' });
    repo.seedCharity({ name: 'Gone', archived: true });
    expect((await service.list({ limit: 20, offset: 0 })).charities.map((c) => c.name)).toEqual([
      'Listed',
    ]);
  });
});

describe('profile (DIR-02)', () => {
  it('returns description, media references and only UPCOMING events, soonest first', async () => {
    repo.seedCharity({
      name: 'Riverside',
      description: 'Coaching.',
      images: [{ path: 'r/1.png', alt: 'kids' }],
      events: [
        { title: 'Later', startsAt: '2026-12-01T10:00:00Z' },
        { title: 'Past', startsAt: '2026-01-01T10:00:00Z' },
        { title: 'Sooner', startsAt: '2026-10-01T10:00:00Z' },
      ],
    });
    const d = await service.detail('riverside');
    expect(d.description).toBe('Coaching.');
    expect(d.images).toEqual([
      {
        id: expect.any(String) as string,
        url: 'https://cdn.test/charity-media/r/1.png',
        altText: 'kids',
      },
    ]);
    expect(d.upcomingEvents.map((e) => e.title)).toEqual(['Sooner', 'Later']);
  });

  it('an event that starts exactly now still counts as upcoming', async () => {
    repo.seedCharity({ name: 'X', events: [{ title: 'Now', startsAt: NOW.toISOString() }] });
    expect((await service.detail('x')).upcomingEvents).toHaveLength(1);
  });

  it('404s for an unknown or archived charity', async () => {
    repo.seedCharity({ name: 'Gone', archived: true });
    for (const slug of ['gone', 'nope']) {
      const err = await rejection(service.detail(slug));
      expect(err.status).toBe(404);
      expect(err.code).toBe(CHARITY_ERROR_CODES.notFound);
    }
  });
});

describe('spotlight (homepage)', () => {
  it('returns featured, listed charities only', async () => {
    repo.seedCharity({ name: 'Plain' });
    repo.seedCharity({ name: 'Star', featured: true });
    repo.seedCharity({ name: 'Old Star', featured: true, archived: true });
    expect((await service.spotlight()).map((c) => c.name)).toEqual(['Star']);
  });

  it('is capped', async () => {
    for (let i = 0; i < CHARITY_SPOTLIGHT_LIMIT + 3; i++)
      repo.seedCharity({ name: `Star ${String(i).padStart(2, '0')}`, featured: true });
    expect(await service.spotlight()).toHaveLength(CHARITY_SPOTLIGHT_LIMIT);
  });

  it('is empty when nothing is featured', async () => {
    repo.seedCharity({ name: 'Plain' });
    expect(await service.spotlight()).toEqual([]);
  });
});

describe('selected charity + percentage (CHR-01, CHR-02, CHR-03)', () => {
  it('reads the stored choice with the PRD minimum and no cap by default', async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, c, 1500);
    expect(await service.getPreference(U)).toEqual({
      charity: { id: c, slug: 'riverside', name: 'Riverside', isArchived: false },
      percentageBps: 1500,
      minBps: 1000,
      maxBps: null,
    });
  });

  it('reports a configured cap and a user who has not chosen yet', async () => {
    repo.setMaxBps(3000);
    repo.seedProfile(U);
    expect(await service.getPreference(U)).toMatchObject({
      charity: null,
      percentageBps: 1000,
      maxBps: 3000,
    });
  });

  it('flags a selected charity that was archived afterwards', async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, c);
    repo.archive(c);
    expect((await service.getPreference(U)).charity?.isArchived).toBe(true);
  });

  it('403 profile_missing when the account has no profile', async () => {
    for (const call of [
      service.getPreference('ghost'),
      service.updatePreference('ghost', { percentageBps: 1500 }),
    ]) {
      const err = await rejection(call);
      expect(err.status).toBe(403);
      expect(err.code).toBe(AUTH_ERROR_CODES.profileMissing);
    }
  });

  describe('percentage rules — minimum 10%, any value up (D-064)', () => {
    beforeEach(() => {
      repo.seedProfile(U, null, 2500);
    });

    it.each([1000, 1001, 2500, 5000, 9999, 10000])('accepts %i basis points', async (bps) => {
      expect((await service.updatePreference(U, { percentageBps: bps })).percentageBps).toBe(bps);
      expect(repo.storedProfile(U)?.bps).toBe(bps);
    });

    it('lets the user LOWER the percentage (down to the minimum) as well as raise it', async () => {
      expect((await service.updatePreference(U, { percentageBps: 1000 })).percentageBps).toBe(1000);
      expect((await service.updatePreference(U, { percentageBps: 4000 })).percentageBps).toBe(4000);
      expect((await service.updatePreference(U, { percentageBps: 1000 })).percentageBps).toBe(1000);
    });

    it.each([0, 1, 500, 999])(
      'rejects %i (below the 10% minimum) and stores nothing',
      async (bps) => {
        const err = await rejection(service.updatePreference(U, { percentageBps: bps }));
        expect(err.status).toBe(422);
        expect(err.code).toBe(CHARITY_ERROR_CODES.percentageBelowMinimum);
        expect(repo.storedProfile(U)?.bps).toBe(2500);
        expect(repo.calls.updatePreference).toBe(0);
      },
    );

    it.each([10001, 20000, -1000])('rejects %i and stores nothing', async (bps) => {
      const err = await rejection(service.updatePreference(U, { percentageBps: bps }));
      expect(err.status).toBe(422);
      expect(repo.storedProfile(U)?.bps).toBe(2500);
    });

    it('rejects a fractional value', async () => {
      const err = await rejection(service.updatePreference(U, { percentageBps: 1500.5 }));
      expect(err.status).toBe(422);
      expect(repo.storedProfile(U)?.bps).toBe(2500);
    });

    it('applies a configured cap: above it → percentage_above_maximum, at it → fine', async () => {
      repo.setMaxBps(3000);
      const err = await rejection(service.updatePreference(U, { percentageBps: 3001 }));
      expect(err.status).toBe(422);
      expect(err.code).toBe(CHARITY_ERROR_CODES.percentageAboveMaximum);
      expect((await service.updatePreference(U, { percentageBps: 3000 })).percentageBps).toBe(3000);
    });
  });

  describe('charity rules', () => {
    it('selects a listed charity', async () => {
      const c = repo.seedCharity({ name: 'Riverside' });
      repo.seedProfile(U);
      const pref = await service.updatePreference(U, { charityId: c });
      expect(pref.charity?.id).toBe(c);
      expect(repo.storedProfile(U)?.charityId).toBe(c);
    });

    it('can change charity and percentage in one request', async () => {
      const c = repo.seedCharity({ name: 'Riverside' });
      repo.seedProfile(U);
      const pref = await service.updatePreference(U, { charityId: c, percentageBps: 2000 });
      expect(pref).toMatchObject({ percentageBps: 2000, charity: { id: c } });
    });

    it('404 for an unknown charity; the stored choice is untouched', async () => {
      const keep = repo.seedCharity({ name: 'Keep' });
      repo.seedProfile(U, keep);
      const err = await rejection(service.updatePreference(U, { charityId: 'c-9999' }));
      expect(err.status).toBe(404);
      expect(err.code).toBe(CHARITY_ERROR_CODES.notFound);
      expect(repo.storedProfile(U)?.charityId).toBe(keep);
    });

    it('422 for an archived charity; the stored choice is untouched', async () => {
      const keep = repo.seedCharity({ name: 'Keep' });
      const gone = repo.seedCharity({ name: 'Gone', archived: true });
      repo.seedProfile(U, keep);
      const err = await rejection(service.updatePreference(U, { charityId: gone }));
      expect(err.status).toBe(422);
      expect(err.code).toBe(CHARITY_ERROR_CODES.unavailable);
      expect(repo.storedProfile(U)?.charityId).toBe(keep);
    });

    it('a rejected charity blocks the percentage in the SAME request (all-or-nothing)', async () => {
      const gone = repo.seedCharity({ name: 'Gone', archived: true });
      repo.seedProfile(U, null, 1000);
      await rejection(service.updatePreference(U, { charityId: gone, percentageBps: 5000 }));
      expect(repo.storedProfile(U)?.bps).toBe(1000);
    });

    it('a bad percentage blocks the charity in the SAME request', async () => {
      const c = repo.seedCharity({ name: 'Riverside' });
      repo.seedProfile(U, null, 1000);
      await rejection(service.updatePreference(U, { charityId: c, percentageBps: 500 }));
      expect(repo.storedProfile(U)?.charityId).toBeNull();
    });

    it('maps the database guard when the charity is archived between check and write', async () => {
      const c = repo.seedCharity({ name: 'Riverside' });
      repo.seedProfile(U);
      // Racing archive: it lands after the service checked, before the write.
      const original = repo.findForSelection.bind(repo);
      repo.findForSelection = async (id) => {
        const found = await original(id);
        repo.archive(c);
        return found;
      };
      const err = await rejection(service.updatePreference(U, { charityId: c }));
      expect(err.status).toBe(422);
      expect(err.code).toBe(CHARITY_ERROR_CODES.unavailable);
      expect(repo.storedProfile(U)?.charityId).toBeNull();
    });
  });

  it('is available without a subscription (the charity is chosen at signup)', async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U); // no subscription concept exists in this service at all
    await expect(
      service.updatePreference(U, { charityId: c, percentageBps: 1200 }),
    ).resolves.toBeDefined();
  });

  it("only ever touches the caller's own profile", async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, null, 1000);
    repo.seedProfile(V, null, 1000);
    await service.updatePreference(U, { charityId: c, percentageBps: 4000 });
    expect(repo.storedProfile(V)).toEqual({ charityId: null, bps: 1000 });
  });

  it('propagates infrastructure failures unchanged (they become a generic 500 at the edge)', async () => {
    repo.failWith = new Error('db down');
    await expect(service.updatePreference(U, { percentageBps: 2000 })).rejects.toThrow('db down');
    await expect(service.getPreference(U)).rejects.toThrow('db down');
  });
});

describe('starting a subscription needs a currently selected, listed charity (CHR-01, D-065)', () => {
  it('passes with a listed charity and returns where the contribution will go', async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, c, 2500);
    expect(await service.requireSubscribableCharity(U)).toEqual({
      charityId: c,
      percentageBps: 2500,
    });
  });

  it('is refused with charity_required when no charity was ever selected', async () => {
    repo.seedProfile(U, null);
    const err = await rejection(service.requireSubscribableCharity(U));
    expect(err.status).toBe(422);
    expect(err.code).toBe(CHARITY_ERROR_CODES.selectionRequired);
  });

  it('is refused with selected_charity_unavailable when the selected charity was archived', async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, c);
    repo.archive(c);
    const err = await rejection(service.requireSubscribableCharity(U));
    expect(err.status).toBe(422);
    expect(err.code).toBe(CHARITY_ERROR_CODES.selectedUnavailable);
    expect(err.message).toMatch(/Choose another charity/);
  });

  it('never substitutes another charity for an archived one', async () => {
    const gone = repo.seedCharity({ name: 'Gone' });
    repo.seedCharity({ name: 'Other listed charity' });
    repo.seedProfile(U, gone);
    repo.archive(gone);
    await rejection(service.requireSubscribableCharity(U));
    expect(repo.storedProfile(U)?.charityId).toBe(gone);
  });

  it('is allowed again as soon as the archived charity is replaced by a listed one', async () => {
    const gone = repo.seedCharity({ name: 'Gone' });
    const next = repo.seedCharity({ name: 'Next' });
    repo.seedProfile(U, gone);
    repo.archive(gone);
    await rejection(service.requireSubscribableCharity(U));
    await service.updatePreference(U, { charityId: next });
    expect((await service.requireSubscribableCharity(U)).charityId).toBe(next);
  });

  it('is not affected by the percentage: any value from 10% up qualifies, including lowering to 10%', async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, c, 5000);
    await service.updatePreference(U, { percentageBps: 1000 });
    expect((await service.requireSubscribableCharity(U)).percentageBps).toBe(1000);
  });

  it("looks only at the caller's own profile", async () => {
    const c = repo.seedCharity({ name: 'Riverside' });
    repo.seedProfile(U, c);
    repo.seedProfile(V, null);
    await expect(service.requireSubscribableCharity(U)).resolves.toBeDefined();
    expect((await rejection(service.requireSubscribableCharity(V))).code).toBe(
      CHARITY_ERROR_CODES.selectionRequired,
    );
  });

  it('403 profile_missing when the account has no profile', async () => {
    const err = await rejection(service.requireSubscribableCharity('ghost'));
    expect(err.status).toBe(403);
    expect(err.code).toBe(AUTH_ERROR_CODES.profileMissing);
  });

  it('a storage failure is not read as "no charity" (fails closed, unchanged)', async () => {
    repo.failWith = new Error('db down');
    await expect(service.requireSubscribableCharity(U)).rejects.toThrow('db down');
  });
});

describe('contributions (CHR-04)', () => {
  it("lists only the caller's contributions, newest first, with per-currency totals", async () => {
    repo.seedContribution(U, {
      amountMinor: 500,
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00Z',
    });
    repo.seedContribution(U, {
      amountMinor: 250,
      currency: 'USD',
      createdAt: '2026-02-01T00:00:00Z',
      source: 'donation',
      percentageBps: null,
      basisMinor: null,
    });
    repo.seedContribution(U, {
      amountMinor: 900,
      currency: 'GBP',
      createdAt: '2026-03-01T00:00:00Z',
    });
    repo.seedContribution(V, { amountMinor: 99999, currency: 'USD' });
    const res = await service.listContributions(U);
    expect(res.contributions.map((c) => c.createdAt)).toEqual([
      '2026-03-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ]);
    expect(res.totals).toEqual([
      { currency: 'GBP', amountMinor: 900 },
      { currency: 'USD', amountMinor: 750 },
    ]);
  });

  it('is empty for a user with none', async () => {
    expect(await service.listContributions(U)).toEqual({ contributions: [], totals: [] });
  });
});

describe('totalsByCurrency', () => {
  it('never mixes currencies and sorts them', () => {
    expect(
      totalsByCurrency([
        { currency: 'USD', amountMinor: 1 },
        { currency: 'EUR', amountMinor: 2 },
        { currency: 'USD', amountMinor: 3 },
      ]),
    ).toEqual([
      { currency: 'EUR', amountMinor: 2 },
      { currency: 'USD', amountMinor: 4 },
    ]);
  });

  it('uses exact integer arithmetic (no floating-point drift)', () => {
    const rows = Array.from({ length: 1000 }, () => ({ currency: 'USD', amountMinor: 10 }));
    expect(totalsByCurrency(rows)).toEqual([{ currency: 'USD', amountMinor: 10_000 }]);
  });

  it('refuses a total beyond the safe integer range instead of silently rounding', () => {
    expect(() =>
      totalsByCurrency([
        { currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER },
        { currency: 'USD', amountMinor: 1 },
      ]),
    ).toThrow(/safe integer/);
  });
});

describe('admin charity management (PRD §11 ADM-05)', () => {
  it('adminList includes archived charities, unlike the public directory', async () => {
    repo.seedCharity({ name: 'Listed One' });
    const archivedId = repo.seedCharity({ name: 'Archived One' });
    repo.archive(archivedId);

    const admin = await service.adminList();
    expect(admin.map((c) => c.name).sort()).toEqual(['Archived One', 'Listed One']);
    expect(admin.find((c) => c.id === archivedId)?.isArchived).toBe(true);

    const publicList = await service.list({ limit: 20, offset: 0 });
    expect(publicList.charities.map((c) => c.name)).toEqual(['Listed One']);
  });

  it('adminDetail 404s an unknown id', async () => {
    const err = await rejection(service.adminDetail('00000000-0000-4000-8000-000000000000'));
    expect(err.status).toBe(404);
    expect(err.code).toBe(CHARITY_ERROR_CODES.notFound);
  });

  it('adminDetail finds an ARCHIVED charity too (unlike the public detail())', async () => {
    const id = repo.seedCharity({ name: 'Archived One', slug: 'archived-one' });
    repo.archive(id);
    const charity = await service.adminDetail(id);
    expect(charity).toMatchObject({ name: 'Archived One', isArchived: true });
    await expect(service.detail('archived-one')).rejects.toMatchObject({ status: 404 });
  });

  it('create() adds a new listed charity', async () => {
    const charity = await service.create({
      slug: 'new-charity',
      name: 'New Charity',
      description: 'Does good.',
    });
    expect(charity).toMatchObject({ slug: 'new-charity', name: 'New Charity', isArchived: false });
    const found = await service.detail('new-charity');
    expect(found.name).toBe('New Charity');
  });

  it('create() reports a duplicate slug as 409, never a generic failure', async () => {
    repo.seedCharity({ name: 'Existing', slug: 'taken' });
    const err = await rejection(service.create({ slug: 'taken', name: 'New', description: 'x' }));
    expect(err.status).toBe(409);
    expect(err.code).toBe(CHARITY_ERROR_CODES.duplicateSlug);
  });

  it('update() changes only the given fields', async () => {
    const id = repo.seedCharity({ name: 'Old Name', description: 'Old.', tags: ['a'] });
    const updated = await service.update(id, { name: 'New Name' });
    expect(updated).toMatchObject({ name: 'New Name', description: 'Old.', tags: ['a'] });
  });

  it('update() 404s an unknown id', async () => {
    const err = await rejection(
      service.update('00000000-0000-4000-8000-000000000000', { name: 'x' }),
    );
    expect(err.status).toBe(404);
  });

  it('archive() hides the charity from the public directory but not from admin', async () => {
    const id = repo.seedCharity({ name: 'To Archive' });
    const archived = await service.archive(id);
    expect(archived.isArchived).toBe(true);
    expect((await service.list({ limit: 20, offset: 0 })).charities).toEqual([]);
    expect((await service.adminList()).find((c) => c.id === id)?.isArchived).toBe(true);
  });

  it('unarchive() restores it to the public directory', async () => {
    const id = repo.seedCharity({ name: 'Restored', archived: true });
    const restored = await service.unarchive(id);
    expect(restored.isArchived).toBe(false);
    expect((await service.list({ limit: 20, offset: 0 })).charities.map((c) => c.id)).toEqual([id]);
  });

  it('archive() and unarchive() 404 an unknown id', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await rejection(service.archive(id))).status).toBe(404);
    expect((await rejection(service.unarchive(id))).status).toBe(404);
  });
});
