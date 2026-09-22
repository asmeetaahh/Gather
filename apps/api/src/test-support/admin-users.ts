import type { AppRole } from '@gather/shared';
import type { AdminUserRepository, AdminUserRow } from '../admin/users/repository.js';

interface StoredUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: AppRole;
  charityName: string | null;
  createdAt: string;
}

/** In-memory stand-in for `AdminUserRepository`. */
export class InMemoryAdminUsers implements AdminUserRepository {
  private readonly users: StoredUser[] = [];
  private readonly active = new Set<string>();
  private readonly scoreCounts = new Map<string, number>();
  failWith: Error | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  seedUser(u: {
    id: string;
    email?: string | null;
    displayName?: string | null;
    role?: AppRole;
    charityName?: string | null;
    createdAt?: string;
  }): void {
    this.users.push({
      id: u.id,
      email: u.email ?? `${u.id}@example.test`,
      displayName: u.displayName ?? null,
      role: u.role ?? 'user',
      charityName: u.charityName ?? null,
      createdAt: u.createdAt ?? '2027-01-01T00:00:00Z',
    });
  }

  setActiveSubscriber(id: string, active: boolean): void {
    if (active) this.active.add(id);
    else this.active.delete(id);
  }

  setScoreCount(id: string, count: number): void {
    this.scoreCounts.set(id, count);
  }

  private toRow(u: StoredUser): AdminUserRow {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      hasActiveSubscription: this.active.has(u.id),
      charityName: u.charityName,
      scoreCount: this.scoreCounts.get(u.id) ?? 0,
      createdAt: u.createdAt,
    };
  }

  list(): Promise<AdminUserRow[]> {
    this.guard();
    return Promise.resolve(
      [...this.users]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((u) => this.toRow(u)),
    );
  }

  findById(id: string): Promise<AdminUserRow | null> {
    this.guard();
    const u = this.users.find((x) => x.id === id);
    return Promise.resolve(u ? this.toRow(u) : null);
  }

  updateDisplayName(id: string, displayName: string): Promise<AdminUserRow | null> {
    this.guard();
    const u = this.users.find((x) => x.id === id);
    if (!u) return Promise.resolve(null);
    u.displayName = displayName;
    return Promise.resolve(this.toRow(u));
  }
}
