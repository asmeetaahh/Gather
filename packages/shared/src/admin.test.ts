import { describe, expect, it } from 'vitest';
import {
  ADMIN_USER_ERROR_CODES,
  API_ADMIN_REPORTS_PATH,
  API_ADMIN_USERS_PATH,
  parseUpdateAdminUserRequest,
} from './admin.js';

describe('paths', () => {
  it('are under the admin prefix', () => {
    expect(API_ADMIN_USERS_PATH).toBe('/api/admin/users');
    expect(API_ADMIN_REPORTS_PATH).toBe('/api/admin/reports');
  });
});

describe('parseUpdateAdminUserRequest', () => {
  it('accepts a non-empty display name, trimmed', () => {
    expect(parseUpdateAdminUserRequest({ displayName: '  Alice  ' })).toEqual({
      ok: true,
      value: { displayName: 'Alice' },
    });
  });

  it('ignores unknown fields such as role or id', () => {
    expect(parseUpdateAdminUserRequest({ displayName: 'Alice', role: 'admin', id: 'x' })).toEqual({
      ok: true,
      value: { displayName: 'Alice' },
    });
  });

  it.each([undefined, null, '', '   ', 5, [], {}, 'x'.repeat(201)])(
    'rejects displayName %j',
    (displayName) => {
      const result = parseUpdateAdminUserRequest({ displayName });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]?.field).toBe('displayName');
    },
  );

  it('accepts a display name at the maximum length', () => {
    const displayName = 'x'.repeat(200);
    expect(parseUpdateAdminUserRequest({ displayName })).toEqual({
      ok: true,
      value: { displayName },
    });
  });

  it.each([null, undefined, 'x', 5, [], true])('rejects a non-object body %j', (body) => {
    const result = parseUpdateAdminUserRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual([{ field: 'body', message: 'A JSON object is required.' }]);
  });
});

describe('ADMIN_USER_ERROR_CODES', () => {
  it('are stable and distinct', () => {
    const codes = Object.values(ADMIN_USER_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(ADMIN_USER_ERROR_CODES.notFound).toBe('admin_user_not_found');
  });
});
