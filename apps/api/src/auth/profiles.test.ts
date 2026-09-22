import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabaseProfileRepository, parseProfileRow } from './profiles.js';

describe('parseProfileRow validates rows at the trust boundary', () => {
  it('accepts a well-formed user and admin row', () => {
    expect(parseProfileRow({ id: 'a', role: 'user', display_name: 'Ann' })).toEqual({
      id: 'a',
      role: 'user',
      displayName: 'Ann',
    });
    expect(parseProfileRow({ id: 'b', role: 'admin', display_name: null })).toEqual({
      id: 'b',
      role: 'admin',
      displayName: null,
    });
  });

  it('fails closed on an unrecognised role instead of defaulting it', () => {
    for (const role of ['superadmin', 'ADMIN', '', null, 1, undefined]) {
      expect(() => parseProfileRow({ id: 'a', role })).toThrow(/role/);
    }
  });

  it('rejects rows that are not objects or lack an id', () => {
    for (const row of [null, undefined, 'x', 3, { role: 'user' }, { id: 5, role: 'user' }]) {
      expect(() => parseProfileRow(row)).toThrow(/Malformed/);
    }
  });
});

/** A stand-in for supabase-js's query builder that records what was asked and returns a canned answer. */
function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: { table?: string; columns?: string; column?: string; value?: string } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.columns = columns;
          return {
            eq(column: string, value: string) {
              calls.column = column;
              calls.value = value;
              return { maybeSingle: () => Promise.resolve(result) };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('createSupabaseProfileRepository', () => {
  it('looks a profile up by id in public.profiles and maps the row', async () => {
    const { client, calls } = fakeClient({
      data: { id: 'user-1', role: 'admin', display_name: 'Root' },
      error: null,
    });
    const profile = await createSupabaseProfileRepository(client).findById('user-1');
    expect(profile).toEqual({ id: 'user-1', role: 'admin', displayName: 'Root' });
    expect(calls).toEqual({
      table: 'profiles',
      columns: 'id, role, display_name',
      column: 'id',
      value: 'user-1',
    });
  });

  it('returns null when there is no profile', async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(createSupabaseProfileRepository(client).findById('nobody')).resolves.toBeNull();
  });

  it('throws (so the request fails closed) when the database lookup fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'connection refused' } });
    await expect(createSupabaseProfileRepository(client).findById('x')).rejects.toThrow(
      /Profile lookup failed/,
    );
  });

  it('throws on a row with an unknown role rather than granting access', async () => {
    const { client } = fakeClient({
      data: { id: 'x', role: 'root', display_name: null },
      error: null,
    });
    await expect(createSupabaseProfileRepository(client).findById('x')).rejects.toThrow(/role/);
  });
});
