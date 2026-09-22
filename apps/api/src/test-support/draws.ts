import type {
  DrawMode,
  DrawStatus,
  DrawTierResultDto,
  MyDrawParticipationDto,
} from '@gather/shared';
import type { PaymentBasis } from '../draws/domain.js';
import {
  DrawStateConflictError,
  type CreateDrawResult,
  type DrawDetailRecord,
  type DrawRecord,
  type DrawRepository,
  type PoolConfig,
  type PublishResult,
  type SimulateInput,
} from '../draws/repository.js';

/**
 * In-memory stand-in for `DrawRepository`. It applies the SAME visible rules the SQL functions do
 * (a published draw cannot be re-simulated; publish is idempotent; winners are created from entries ×
 * tier results at publish time) so service-level scenarios read naturally — it is NOT the authority for
 * those rules; `supabase/tests/draws-function.test.ts` proves them on PostgreSQL.
 */

interface StoredDraw {
  id: string;
  drawMonth: string;
  mode: DrawMode;
  status: DrawStatus;
  scheduledAt: string | null;
  simulatedAt: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  currency: string | null;
  prizePoolMinor: number | null;
  poolContributionBps: number | null;
  poolContributionFixedMinor: number | null;
  activeSubscriberCount: number | null;
  winningNumbers: number[] | null;
  entries: { userId: string; entryNumbers: number[]; matchCount: number }[];
  tierResults: DrawTierResultDto[];
  winners: { userId: string; matchCount: 3 | 4 | 5; prizeMinor: number }[];
}

export interface StoredWinner {
  drawId: string;
  userId: string;
  matchCount: 3 | 4 | 5;
  prizeMinor: number;
}

function toRecord(d: StoredDraw): DrawRecord {
  return {
    id: d.id,
    drawMonth: d.drawMonth,
    mode: d.mode,
    status: d.status,
    scheduledAt: d.scheduledAt,
    simulatedAt: d.simulatedAt,
    publishedAt: d.publishedAt,
    currency: d.currency,
    prizePoolMinor: d.prizePoolMinor,
    activeSubscriberCount: d.activeSubscriberCount,
  };
}

function toDetailRecord(d: StoredDraw): DrawDetailRecord {
  return { ...toRecord(d), winningNumbers: d.winningNumbers, tierResults: d.tierResults };
}

export class InMemoryDraws implements DrawRepository {
  private readonly draws: StoredDraw[] = [];
  private numberRange: { min: number; max: number } | null = { min: 1, max: 45 };
  private pool: PoolConfig | null = null;
  private readonly eligible = new Map<string, number[]>();
  private readonly payments: PaymentBasis[] = [];
  private activePlanCurrency: string | null = null;
  private nextId = 1;
  failWith: Error | null = null;
  readonly calls = { simulate: 0, publish: 0, create: 0 };

  private id(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }
  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  // ---- seeding ---------------------------------------------------------------------------------
  setNumberRange(range: { min: number; max: number } | null): void {
    this.numberRange = range;
  }
  setPoolBps(bps: number): void {
    this.pool = { kind: 'bps', bps };
  }
  setPoolFixed(fixedMinor: number): void {
    this.pool = { kind: 'fixed', fixedMinor };
  }
  clearPool(): void {
    this.pool = null;
  }
  setActivePlanCurrency(currency: string | null): void {
    this.activePlanCurrency = currency;
  }
  /** An active subscriber and their (up to five) latest scores, newest first. */
  seedEligible(userId: string, scores: number[] = []): void {
    this.eligible.set(userId, scores);
  }
  seedPayment(basis: PaymentBasis): void {
    this.payments.push(basis);
  }
  /** Directly seeds a PUBLISHED draw carrying a jackpot rollover, for rollover-chain tests. */
  seedPublishedJackpotRollover(drawMonth: string, rolloverOutMinor: number): string {
    const id = this.id();
    this.draws.push({
      id,
      drawMonth,
      mode: 'random',
      status: 'published',
      scheduledAt: null,
      simulatedAt: '2020-01-01T00:00:00Z',
      publishedAt: '2020-01-01T00:00:00Z',
      publishedBy: null,
      currency: 'USD',
      prizePoolMinor: rolloverOutMinor,
      poolContributionBps: null,
      poolContributionFixedMinor: null,
      activeSubscriberCount: 0,
      winningNumbers: [1, 2, 3, 4, 5],
      entries: [],
      tierResults: [
        {
          matchCount: 5,
          shareBps: 4000,
          rollsOver: true,
          basePoolMinor: rolloverOutMinor,
          rolloverInMinor: 0,
          winnersCount: 0,
          prizePerWinnerMinor: 0,
          remainderMinor: 0,
          rolloverOutMinor,
        },
      ],
      winners: [],
    });
    return id;
  }
  winnersOf(drawId: string): StoredWinner[] {
    const draw = this.draws.find((d) => d.id === drawId);
    return (draw?.winners ?? []).map((w) => ({ drawId, ...w }));
  }
  drawRow(drawId: string): { status: DrawStatus } | undefined {
    return this.draws.find((d) => d.id === drawId);
  }

  // ---- DrawRepository ---------------------------------------------------------------------------
  getSettings(): Promise<{
    numberRange: { min: number; max: number } | null;
    pool: PoolConfig | null;
  }> {
    this.guard();
    return Promise.resolve({ numberRange: this.numberRange, pool: this.pool });
  }

  findByMonth(drawMonth: string): Promise<DrawRecord | null> {
    this.guard();
    const d = this.draws.find((x) => x.drawMonth === drawMonth);
    return Promise.resolve(d ? toRecord(d) : null);
  }

  findById(id: string): Promise<DrawDetailRecord | null> {
    this.guard();
    const d = this.draws.find((x) => x.id === id);
    return Promise.resolve(d ? toDetailRecord(d) : null);
  }

  list(): Promise<DrawRecord[]> {
    this.guard();
    return Promise.resolve(
      [...this.draws].sort((a, b) => b.drawMonth.localeCompare(a.drawMonth)).map(toRecord),
    );
  }

  create(input: {
    drawMonth: string;
    mode: DrawMode;
    createdBy: string;
  }): Promise<CreateDrawResult> {
    this.calls.create++;
    this.guard();
    void input.createdBy;
    if (this.draws.some((d) => d.drawMonth === input.drawMonth)) {
      return Promise.resolve({ kind: 'duplicate_month' });
    }
    const draw: StoredDraw = {
      id: this.id(),
      drawMonth: input.drawMonth,
      mode: input.mode,
      status: 'draft',
      scheduledAt: null,
      simulatedAt: null,
      publishedAt: null,
      publishedBy: null,
      currency: null,
      prizePoolMinor: null,
      poolContributionBps: null,
      poolContributionFixedMinor: null,
      activeSubscriberCount: null,
      winningNumbers: null,
      entries: [],
      tierResults: [],
      winners: [],
    };
    this.draws.push(draw);
    return Promise.resolve({ kind: 'created', draw: toRecord(draw) });
  }

  listEligibleTickets(): Promise<Map<string, number[]>> {
    this.guard();
    return Promise.resolve(new Map(this.eligible));
  }

  listPaymentBasesFunding(): Promise<PaymentBasis[]> {
    this.guard();
    return Promise.resolve([...this.payments]);
  }

  getActiveMonthlyPlanCurrency(): Promise<string | null> {
    this.guard();
    return Promise.resolve(this.activePlanCurrency);
  }

  getPriorJackpotRollover(drawMonth: string): Promise<number> {
    this.guard();
    const priors = this.draws
      .filter((d) => d.status === 'published' && d.drawMonth < drawMonth)
      .sort((a, b) => b.drawMonth.localeCompare(a.drawMonth));
    const prior = priors[0];
    const tier5 = prior?.tierResults.find((t) => t.matchCount === 5);
    return Promise.resolve(tier5?.rolloverOutMinor ?? 0);
  }

  simulate(input: SimulateInput): Promise<void> {
    this.calls.simulate++;
    this.guard();
    const draw = this.draws.find((d) => d.id === input.drawId);
    if (!draw) throw new Error('No such draw');
    if (draw.status === 'published') throw new DrawStateConflictError('already_published');

    draw.entries = input.entries;
    draw.tierResults = input.tierResults.map((t) => ({ ...t }));
    draw.winningNumbers = input.winningNumbers;
    draw.status = 'simulated';
    draw.simulatedAt = new Date().toISOString();
    draw.activeSubscriberCount = input.activeSubscriberCount;
    draw.currency = input.currency;
    draw.prizePoolMinor = input.prizePoolMinor;
    draw.poolContributionBps = input.poolContributionBps;
    draw.poolContributionFixedMinor = input.poolContributionFixedMinor;
    return Promise.resolve();
  }

  publish(drawId: string, publishedBy: string): Promise<PublishResult> {
    this.calls.publish++;
    this.guard();
    const draw = this.draws.find((d) => d.id === drawId);
    if (!draw) throw new Error('No such draw');
    if (draw.status === 'published') return Promise.resolve('already_published');
    if (draw.status !== 'simulated') throw new DrawStateConflictError('not_simulated');

    draw.status = 'published';
    draw.publishedAt = new Date().toISOString();
    draw.publishedBy = publishedBy;
    draw.winners = draw.entries
      .filter((e): e is typeof e & { matchCount: 3 | 4 | 5 } => [3, 4, 5].includes(e.matchCount))
      .map((e) => {
        const tier = draw.tierResults.find((t) => t.matchCount === e.matchCount);
        return {
          userId: e.userId,
          matchCount: e.matchCount,
          prizeMinor: tier?.prizePerWinnerMinor ?? 0,
        };
      });
    return Promise.resolve('published');
  }

  listMyParticipation(userId: string): Promise<MyDrawParticipationDto[]> {
    this.guard();
    const rows = this.draws
      .filter((d) => d.status === 'published')
      .flatMap((d) =>
        d.entries
          .filter((e) => e.userId === userId)
          .map((e): MyDrawParticipationDto => ({
            drawId: d.id,
            drawMonth: d.drawMonth,
            mode: d.mode,
            winningNumbers: d.winningNumbers ?? [],
            matchCount: e.matchCount,
          })),
      )
      .sort((a, b) => b.drawMonth.localeCompare(a.drawMonth));
    return Promise.resolve(rows);
  }
}
