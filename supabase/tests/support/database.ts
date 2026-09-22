import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');
const SHIM_FILE = join(import.meta.dirname, 'supabase-shim.sql');

/** Migration files in the order Supabase applies them (lexicographic by timestamp prefix). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * A fresh in-memory PostgreSQL with the Supabase shim and EVERY migration applied, in order,
 * exactly as they would be on a clean project. Throws if any migration fails.
 */
export async function createMigratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(SHIM_FILE, 'utf8'));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return db;
}

export type DbRole = 'anon' | 'authenticated' | 'service_role';

export interface Actor {
  role: DbRole;
  /** The JWT `sub` claim (auth.uid()). Omit for anon. */
  userId?: string;
  /** Extra JWT claims, e.g. to prove that forged "admin" claims are ignored. */
  claims?: Record<string, unknown>;
}

/** Thrown internally to force a rollback after the callback has produced its result. */
class Rollback extends Error {}

/**
 * Switches the current transaction to an API role the way PostgREST does per request:
 * SET LOCAL ROLE plus the request.jwt.claims setting that auth.uid() reads.
 */
export async function impersonate(tx: Transaction, actor: Actor): Promise<void> {
  await tx.exec(`set local role ${actor.role}`);
  const claims = JSON.stringify({
    role: actor.role,
    ...(actor.userId && { sub: actor.userId }),
    ...actor.claims,
  });
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
}

/**
 * Runs `fn` inside a transaction while impersonating an API role, the same way PostgREST does
 * (SET LOCAL ROLE + request.jwt.claims). ALWAYS rolls back, so tests can mutate freely and
 * leave the shared fixtures untouched. Errors thrown by `fn` propagate to the caller.
 */
export async function as<T>(
  db: PGlite,
  actor: Actor,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      await impersonate(tx, actor);
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

/** Runs `fn` as the database owner (bypasses RLS) and rolls back. Used to test triggers/checks. */
export async function asOwner<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

export interface PgError {
  code?: string;
  message: string;
  constraint?: string;
}

/** SQLSTATE codes used in assertions. */
export const PG = {
  checkViolation: '23514',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  /** Raised by a foreign key declared ON DELETE RESTRICT (NO ACTION raises 23503 instead). */
  restrictViolation: '23001',
  notNullViolation: '23502',
  integrityViolation: '23000',
  insufficientPrivilege: '42501',
} as const;

/**
 * Like pgError, but for use INSIDE a transaction that must keep going afterwards: PostgreSQL
 * aborts the whole transaction on any error, so the failing statement runs under a savepoint
 * that is rolled back.
 */
export async function attempt(
  tx: Transaction,
  statement: () => Promise<unknown>,
): Promise<PgError> {
  await tx.exec('savepoint attempt');
  try {
    await statement();
  } catch (error) {
    await tx.exec('rollback to savepoint attempt');
    return error as PgError;
  }
  await tx.exec('release savepoint attempt');
  throw new Error('Expected the statement to fail, but it succeeded');
}

/** Awaits a statement that must fail and returns the Postgres error for inspection. */
export async function pgError(statement: Promise<unknown>): Promise<PgError> {
  try {
    await statement;
  } catch (error) {
    return error as PgError;
  }
  throw new Error('Expected the statement to fail, but it succeeded');
}
