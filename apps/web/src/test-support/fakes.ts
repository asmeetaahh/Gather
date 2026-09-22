import type { Session } from '@supabase/supabase-js';
import { vi } from 'vitest';
import type {
  AppRole,
  CharityDetailDto,
  CharityPreferenceDto,
  CharitySummaryDto,
  MeResponse,
  MyDrawParticipationDto,
  PayoutStatus,
  PlanDto,
  ScoreDto,
  SubscriptionDto,
  VerificationStatus,
  WinnerDetailDto,
} from '@gather/shared';
import type { AuthClient } from '../auth/types';

/**
 * Test doubles for the two boundaries the web app talks across. No real Supabase project exists yet, so
 * the Supabase client is faked here; the app's own logic (provider, guards, forms) runs for real.
 */

export const fakeSession = (accessToken: string): Session =>
  ({
    access_token: accessToken,
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: 'u' },
  }) as unknown as Session;

type Listener = (event: string, session: Session | null) => void;
interface AuthErrorStub {
  code?: string;
  message: string;
  status?: number;
}

export function createFakeAuthClient(initialSession: Session | null = null) {
  let session = initialSession;
  const listeners = new Set<Listener>();
  const emit = (event: string, next: Session | null) =>
    listeners.forEach((l) => {
      l(event, next);
    });

  /** Knobs a test can turn before acting. */
  const behaviour = {
    signInError: null as AuthErrorStub | null,
    signInToken: 'token-alice',
    signUpError: null as AuthErrorStub | null,
    /** null = the project requires email confirmation (no session yet). */
    signUpSessionToken: null as string | null,
  };

  const auth = {
    // Like supabase-js: registering a listener emits INITIAL_SESSION with the restored session.
    onAuthStateChange: vi.fn((callback: Listener) => {
      listeners.add(callback);
      queueMicrotask(() => {
        callback('INITIAL_SESSION', session);
      });
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    }),
    getSession: vi.fn(() => Promise.resolve({ data: { session }, error: null })),
    signInWithPassword: vi.fn((_credentials: { email: string; password: string }) => {
      if (behaviour.signInError)
        return Promise.resolve({
          data: { session: null, user: null },
          error: behaviour.signInError,
        });
      session = fakeSession(behaviour.signInToken);
      emit('SIGNED_IN', session);
      return Promise.resolve({ data: { session, user: {} }, error: null });
    }),
    signUp: vi.fn(
      (_credentials: {
        email: string;
        password: string;
        options?: { data?: Record<string, unknown> };
      }) => {
        if (behaviour.signUpError)
          return Promise.resolve({
            data: { session: null, user: null },
            error: behaviour.signUpError,
          });
        session = behaviour.signUpSessionToken ? fakeSession(behaviour.signUpSessionToken) : null;
        if (session) emit('SIGNED_IN', session);
        return Promise.resolve({ data: { session, user: {} }, error: null });
      },
    ),
    signOut: vi.fn((_options?: { scope: string }) => {
      session = null;
      emit('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    }),
  };

  /** Knobs a test can turn for the direct-to-storage proof upload (ARCHITECTURE.md §10). */
  const storageBehaviour = {
    uploadError: null as { message: string } | null,
  };
  const uploadedObjects = new Map<string, { bucket: string; path: string }>();
  const storage = {
    from: vi.fn((bucket: string) => ({
      upload: vi.fn((path: string, _file: unknown, _options?: { contentType?: string }) => {
        if (storageBehaviour.uploadError) {
          return Promise.resolve({ data: null, error: storageBehaviour.uploadError });
        }
        uploadedObjects.set(`${bucket}/${path}`, { bucket, path });
        return Promise.resolve({
          data: { id: 'obj1', path, fullPath: `${bucket}/${path}` },
          error: null,
        });
      }),
    })),
  };

  return {
    client: { auth, storage } as unknown as AuthClient,
    auth,
    storage,
    behaviour,
    storageBehaviour,
    uploadedObjects,
  };
}

/** A charity as the public API returns it (profile shape), for `stubApi({ charities })`. */
export function charity(n: number, overrides: Partial<CharityDetailDto> = {}): CharityDetailDto {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    slug: `charity-${String(n)}`,
    name: `Charity ${String(n)}`,
    description: `Description of charity ${String(n)}.`,
    tags: [],
    isFeatured: false,
    images: [],
    upcomingEvents: [],
    ...overrides,
  };
}

export interface ApiUser {
  id: string;
  email: string;
  role: AppRole;
  displayName: string | null;
}
export const ALICE: ApiUser = {
  id: 'a1',
  email: 'alice@example.test',
  role: 'user',
  displayName: null,
};
export const BOB: ApiUser = {
  id: 'b1',
  email: 'bob@example.test',
  role: 'user',
  displayName: null,
};
export const ADMIN: ApiUser = {
  id: 'ad',
  email: 'root@example.test',
  role: 'admin',
  displayName: 'Root',
};

/** A seeded winner for `stubApi({ winners })`, owned by whichever token created it. */
export interface StubWinner {
  id: string;
  ownerToken: string;
  drawMonth: string;
  matchCount: 3 | 4 | 5;
  prizeMinor: number;
  currency: string;
  verificationStatus: VerificationStatus;
  payoutStatus: PayoutStatus;
  reviewNote?: string | null;
  proofs?: { id: string; storagePath: string; uploadedAt: string; url: string | null }[];
}
export function stubWinner(n: number, overrides: Partial<StubWinner> = {}): StubWinner {
  return {
    id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    ownerToken: 'token-alice',
    drawMonth: '2027-01-01',
    matchCount: 3,
    prizeMinor: 1000,
    currency: 'USD',
    verificationStatus: 'awaiting_proof',
    payoutStatus: 'pending',
    proofs: [],
    ...overrides,
  };
}

/**
 * Stubs `fetch` as the GATHER API. `users` maps access tokens to the profile the API would return; any
 * other token gets a 401, like the real verifier. Every request is recorded in `calls`.
 */
export function stubApi(
  options: {
    users?: Record<string, ApiUser>;
    /** Simulate the API being unreachable. */
    down?: boolean;
    /** Tokens for accounts that authenticate but have no profile (403). */
    noProfile?: string[];
    /** Override what /api/admin/check answers (default: allowed iff the user's role is admin). */
    adminCheck?: (token: string) => number;
    /** The LISTED charities the public directory serves. */
    charities?: CharityDetailDto[];
    /** Archived charities: not in any public list, but a user may still have chosen one earlier. */
    archived?: CharityDetailDto[];
    /** Each user's stored choice, by access token. Others start with no charity at 10%. */
    preferences?: Record<string, { charityId: string | null; percentageBps: number }>;
    /** A configured product cap on the percentage (default: none). */
    maxBps?: number | null;
    /** Make the public charity endpoints fail with this status. */
    charitiesFail?: number;
    /** The plans `GET /api/plans` serves (public). */
    plans?: PlanDto[];
    /** Each user's subscription, by access token (default: none). */
    subscriptions?: Record<string, SubscriptionDto | null>;
    /** Make checkout fail the way the API does: HTTP status and stable error code. */
    checkoutError?: { status: number; code?: string };
    /** Make `GET /api/plans` or `GET /api/me/subscription` fail with this status. */
    billingFail?: number;
    /** Seeded winners, each owned by one access token (see `stubWinner`). */
    winners?: StubWinner[];
    /** Each user's starting scores, by access token (default: none). Mutated by add/edit/delete. */
    scores?: Record<string, ScoreDto[]>;
    /** Each user's published-draw participation, by access token (default: none; read-only). */
    draws?: Record<string, MyDrawParticipationDto[]>;
  } = {},
) {
  const calls: {
    path: string;
    token: string | null;
    method: string;
    search: string;
    body: unknown;
  }[] = [];
  const json = (status: number, body: unknown) => Response.json(body, { status });
  const error = (status: number, code: string, message = 'x') =>
    json(status, { error: { code, message } });

  const listed = options.charities ?? [];
  const known = [...listed, ...(options.archived ?? [])];
  const stored = new Map(Object.entries(options.preferences ?? {}));
  const summaryOf = (c: CharityDetailDto): CharitySummaryDto => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    summary: c.description,
    tags: c.tags,
    isFeatured: c.isFeatured,
    coverImage: c.images[0] ?? null,
    nextEventAt: c.upcomingEvents[0]?.startsAt ?? null,
  });
  const preferenceOf = (token: string): CharityPreferenceDto => {
    const p = stored.get(token) ?? { charityId: null, percentageBps: 1000 };
    const c = known.find((k) => k.id === p.charityId);
    return {
      charity: c ? { id: c.id, slug: c.slug, name: c.name, isArchived: !listed.includes(c) } : null,
      percentageBps: p.percentageBps,
      minBps: 1000,
      maxBps: options.maxBps ?? null,
    };
  };

  /** The public charity endpoints (no sign-in), mirroring the API's filtering and paging. */
  function publicCharities(path: string, params: URLSearchParams): Response | null {
    if (
      path !== '/api/charities' &&
      path !== '/api/charity-spotlight' &&
      !path.startsWith('/api/charities/')
    )
      return null;
    if (options.charitiesFail) return error(options.charitiesFail, 'internal_error');

    if (path === '/api/charity-spotlight')
      return json(200, { charities: listed.filter((c) => c.isFeatured).map(summaryOf) });

    if (path === '/api/charities') {
      const q = params.get('q')?.toLowerCase();
      const tag = params.get('tag');
      const limit = Number(params.get('limit') ?? 20);
      const offset = Number(params.get('offset') ?? 0);
      const matches = listed
        .filter((c) => !q || `${c.name} ${c.description}`.toLowerCase().includes(q))
        .filter((c) => !tag || c.tags.includes(tag))
        .filter((c) => params.get('featured') !== 'true' || c.isFeatured);
      return json(200, {
        charities: matches.slice(offset, offset + limit).map(summaryOf),
        limit,
        offset,
        hasMore: matches.length > offset + limit,
      });
    }

    const found = listed.find((c) => c.slug === decodeURIComponent(path.split('/').pop() ?? ''));
    return found ? json(200, { charity: found }) : error(404, 'charity_not_found');
  }

  /** `/api/me/charity`: the same rules the API applies (minimum, cap, unknown / archived charity). */
  function myCharity(token: string, method: string, body: unknown): Response {
    if (method === 'GET') return json(200, { preference: preferenceOf(token) });
    const patch = (body ?? {}) as { charityId?: string; percentageBps?: number };
    const current = stored.get(token) ?? { charityId: null, percentageBps: 1000 };
    if (patch.percentageBps !== undefined) {
      if (patch.percentageBps < 1000)
        return error(
          422,
          'percentage_below_minimum',
          'The charity contribution must be at least 10%.',
        );
      if (patch.percentageBps > (options.maxBps ?? 10000))
        return error(
          422,
          'percentage_above_maximum',
          'That percentage is above the maximum allowed.',
        );
    }
    if (patch.charityId !== undefined) {
      const target = known.find((k) => k.id === patch.charityId);
      if (!target) return error(404, 'charity_not_found', 'That charity was not found.');
      if (!listed.includes(target))
        return error(422, 'charity_unavailable', 'That charity is no longer available to select.');
    }
    stored.set(token, {
      charityId: patch.charityId ?? current.charityId,
      percentageBps: patch.percentageBps ?? current.percentageBps,
    });
    return json(200, { preference: preferenceOf(token) });
  }

  // ---- winners (PRD §09/§11): mutable copy so upload/reopen/review/paid can change state ------
  const winners = (options.winners ?? []).map((w) => ({ ...w, proofs: [...(w.proofs ?? [])] }));
  const summaryOfWinner = (w: (typeof winners)[number]) => ({
    id: w.id,
    drawId: w.id,
    drawMonth: w.drawMonth,
    matchCount: w.matchCount,
    prizeMinor: w.prizeMinor,
    currency: w.currency,
    verificationStatus: w.verificationStatus,
    payoutStatus: w.payoutStatus,
    createdAt: '2027-01-01T00:00:00Z',
  });
  const detailOfWinner = (w: (typeof winners)[number]): WinnerDetailDto => ({
    ...summaryOfWinner(w),
    reviewedAt: w.reviewNote ? '2027-01-02T00:00:00Z' : null,
    reviewNote: w.reviewNote ?? null,
    paidAt: w.payoutStatus === 'paid' ? '2027-01-03T00:00:00Z' : null,
    proofs: [...w.proofs].reverse(),
  });

  /** `/api/me/winners/*`: scoped to the caller's own winners (owned by their token). */
  function myWinners(token: string, path: string, method: string, body: unknown): Response {
    const mine = winners.filter((w) => w.ownerToken === token);
    if (path === '/api/me/winners') return json(200, { winners: mine.map(summaryOfWinner) });

    const match = /^\/api\/me\/winners\/([^/]+)(\/proof(\/reopen)?)?$/.exec(path);
    const id = match?.[1];
    const w = mine.find((x) => x.id === id);
    if (!w) return error(404, 'winner_not_found', 'No such winner exists.');

    if (path === `/api/me/winners/${id}` && method === 'GET') {
      return json(200, { winner: detailOfWinner(w) });
    }
    if (path === `/api/me/winners/${id}/proof` && method === 'POST') {
      if (w.verificationStatus !== 'awaiting_proof') {
        return error(409, 'winner_proof_not_awaiting', 'This winner is not awaiting proof.');
      }
      const storagePath = (body as { storagePath?: string } | undefined)?.storagePath ?? '';
      w.proofs.push({
        id: `p${String(w.proofs.length + 1)}`,
        storagePath,
        uploadedAt: '2027-01-02T00:00:00Z',
        url: `https://signed.test/${storagePath}`,
      });
      w.verificationStatus = 'pending_review';
      return json(200, { winner: detailOfWinner(w) });
    }
    if (path === `/api/me/winners/${id}/proof/reopen` && method === 'POST') {
      if (w.verificationStatus !== 'rejected') {
        return error(409, 'winner_not_rejected', 'Only a rejected submission can be reopened.');
      }
      w.verificationStatus = 'awaiting_proof';
      return json(200, { winner: detailOfWinner(w) });
    }
    return error(404, 'not_found', 'x');
  }

  /** `/api/admin/winners/*`: every winner, admin only (gated the same way `/api/admin/check` is). */
  function adminWinners(
    user: ApiUser,
    token: string,
    path: string,
    method: string,
    body: unknown,
  ): Response {
    const allowed = options.adminCheck ? options.adminCheck(token) === 200 : user.role === 'admin';
    if (!allowed) return error(403, 'forbidden', 'x');

    if (path === '/api/admin/winners') return json(200, { winners: winners.map(summaryOfWinner) });

    const match = /^\/api\/admin\/winners\/([^/]+)(\/review|\/paid)?$/.exec(path);
    const id = match?.[1];
    const w = winners.find((x) => x.id === id);
    if (!w) return error(404, 'winner_not_found', 'No such winner exists.');

    if (path === `/api/admin/winners/${id}` && method === 'GET') {
      return json(200, { winner: detailOfWinner(w) });
    }
    if (path === `/api/admin/winners/${id}/review` && method === 'POST') {
      if (w.verificationStatus !== 'pending_review') {
        return error(409, 'winner_not_pending_review', 'This winner is not pending review.');
      }
      const patch = body as { decision?: 'approved' | 'rejected'; note?: string };
      w.verificationStatus = patch.decision ?? w.verificationStatus;
      w.reviewNote = patch.note ?? null;
      return json(200, { winner: detailOfWinner(w) });
    }
    if (path === `/api/admin/winners/${id}/paid` && method === 'POST') {
      if (w.verificationStatus !== 'approved' && w.payoutStatus !== 'paid') {
        return error(409, 'winner_not_approved_for_payout', 'Not approved yet.');
      }
      w.payoutStatus = 'paid';
      return json(200, { winner: detailOfWinner(w) });
    }
    return error(404, 'not_found', 'x');
  }

  // ---- scores (PRD §05; dashboard DSH-02): a simplified replace-oldest, good enough to drive UI
  // interaction tests. The real rule is proven at the API/database layers, not re-implemented here.
  const scoresByToken = new Map(
    Object.entries(options.scores ?? {}).map(([token, list]) => [token, [...list]]),
  );
  function myScores(token: string, path: string, method: string, body: unknown): Response {
    const mine = () => scoresByToken.get(token) ?? [];
    if (path === '/api/scores' && method === 'GET') {
      return json(200, {
        scores: [...mine()].sort((a, b) => b.playedOn.localeCompare(a.playedOn)),
      });
    }
    if (path === '/api/scores' && method === 'POST') {
      const patch = body as { playedOn?: string; stablefordScore?: number };
      if (!patch.playedOn || !patch.stablefordScore) return error(400, 'validation_failed', 'x');
      const list = mine();
      if (list.some((s) => s.playedOn === patch.playedOn)) {
        return error(409, 'score_date_exists', 'You already have a score for that date.');
      }
      let replacedPlayedOn: string | null = null;
      let next = list;
      if (list.length >= 5) {
        const oldest = [...list].sort((a, b) => a.playedOn.localeCompare(b.playedOn))[0];
        replacedPlayedOn = oldest?.playedOn ?? null;
        next = list.filter((s) => s.playedOn !== replacedPlayedOn);
      }
      const score: ScoreDto = {
        id: `score-${String(next.length + 1)}-${patch.playedOn}`,
        playedOn: patch.playedOn,
        stablefordScore: patch.stablefordScore,
        createdAt: '2027-01-01T00:00:00Z',
        updatedAt: '2027-01-01T00:00:00Z',
      };
      scoresByToken.set(token, [...next, score]);
      return json(201, { score, replacedPlayedOn });
    }
    const match = /^\/api\/scores\/([^/]+)$/.exec(path);
    const playedOn = match?.[1];
    const existing = mine().find((s) => s.playedOn === playedOn);
    if (!existing) return error(404, 'score_not_found', 'No score for that date.');
    if (method === 'PUT') {
      const patch = body as { stablefordScore?: number };
      if (!patch.stablefordScore) return error(400, 'validation_failed', 'x');
      const updated: ScoreDto = { ...existing, stablefordScore: patch.stablefordScore };
      scoresByToken.set(
        token,
        mine().map((s) => (s.playedOn === playedOn ? updated : s)),
      );
      return json(200, { score: updated });
    }
    if (method === 'DELETE') {
      scoresByToken.set(
        token,
        mine().filter((s) => s.playedOn !== playedOn),
      );
      return new Response(null, { status: 204 });
    }
    return error(404, 'not_found', 'x');
  }

  // ---- draw participation (PRD §10 DSH-04): read-only.
  function myDraws(token: string): Response {
    return json(200, { draws: options.draws?.[token] ?? [] });
  }

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const { pathname: path, searchParams } = new URL(url, 'http://localhost');
      const header = new Headers(init?.headers).get('authorization');
      const token = header?.replace(/^Bearer /, '') ?? null;
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path, token, method, search: searchParams.toString(), body });

      if (options.down) return Promise.reject(new TypeError('Failed to fetch'));
      if (path === '/api/health')
        return Promise.resolve(
          json(200, { status: 'ok', service: 'gather-api', timestamp: new Date().toISOString() }),
        );

      const publicResponse = publicCharities(path, searchParams);
      if (publicResponse) return Promise.resolve(publicResponse);
      if (path === '/api/plans') {
        return Promise.resolve(
          options.billingFail
            ? error(options.billingFail, 'internal_error')
            : json(200, { plans: options.plans ?? [] }),
        );
      }

      const user = token ? options.users?.[token] : undefined;
      if (!token || (!user && !options.noProfile?.includes(token))) {
        return Promise.resolve(json(401, { error: { code: 'invalid_token', message: 'x' } }));
      }
      if (!user)
        return Promise.resolve(json(403, { error: { code: 'profile_missing', message: 'x' } }));

      if (path === '/api/me') return Promise.resolve(json(200, { user } satisfies MeResponse));
      if (path === '/api/me/charity') return Promise.resolve(myCharity(token, method, body));
      if (path.startsWith('/api/me/subscription')) {
        if (options.billingFail && method === 'GET')
          return Promise.resolve(error(options.billingFail, 'internal_error'));
        const subscription = options.subscriptions?.[token] ?? null;
        if (path === '/api/me/subscription')
          return Promise.resolve(
            json(200, { subscription, canManageBilling: subscription !== null }),
          );
        if (path === '/api/me/subscription/checkout') {
          if (options.checkoutError)
            return Promise.resolve(
              error(options.checkoutError.status, options.checkoutError.code ?? 'internal_error'),
            );
          return Promise.resolve(json(200, { url: 'https://checkout.stripe.test/c/1' }));
        }
        if (path === '/api/me/subscription/portal')
          return Promise.resolve(json(200, { url: 'https://billing.stripe.test/p/1' }));
      }
      if (path === '/api/admin/check') {
        const status = options.adminCheck
          ? options.adminCheck(token)
          : user.role === 'admin'
            ? 200
            : 403;
        return Promise.resolve(
          status === 200
            ? json(200, { ok: true, role: 'admin' })
            : json(status, { error: { code: 'forbidden', message: 'x' } }),
        );
      }
      if (path.startsWith('/api/me/winners'))
        return Promise.resolve(myWinners(token, path, method, body));
      if (path.startsWith('/api/admin/winners'))
        return Promise.resolve(adminWinners(user, token, path, method, body));
      if (path.startsWith('/api/scores'))
        return Promise.resolve(myScores(token, path, method, body));
      if (path === '/api/me/draws') return Promise.resolve(myDraws(token));
      return Promise.resolve(json(404, { error: { code: 'not_found', message: 'x' } }));
    }),
  );

  return { calls, stored };
}
