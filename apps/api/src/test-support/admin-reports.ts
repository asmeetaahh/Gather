import type { AdminReportsRepository, CurrencyTotal } from '../admin/reports/repository.js';

/** In-memory stand-in for `AdminReportsRepository`. */
export class InMemoryAdminReports implements AdminReportsRepository {
  private userCount = 0;
  private activeSubscribers = 0;
  private contributions: CurrencyTotal[] = [];
  failWith: Error | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  setUserCount(n: number): void {
    this.userCount = n;
  }
  setActiveSubscribers(n: number): void {
    this.activeSubscribers = n;
  }
  setCharityContributions(totals: CurrencyTotal[]): void {
    this.contributions = totals;
  }

  countUsers(): Promise<number> {
    this.guard();
    return Promise.resolve(this.userCount);
  }
  countActiveSubscribers(): Promise<number> {
    this.guard();
    return Promise.resolve(this.activeSubscribers);
  }
  charityContributionsByCurrency(): Promise<CurrencyTotal[]> {
    this.guard();
    return Promise.resolve(this.contributions);
  }
}
