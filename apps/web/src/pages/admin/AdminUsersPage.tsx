import { Link } from 'react-router-dom';
import type { AdminUserSummaryDto } from '@gather/shared';
import { fetchAdminUsers } from '../../api/admin';
import { useMyData } from '../../lib/useMyData';

/** User management (PRD §11 ADM-01): every user, with enough to triage without opening a detail view. */
export function AdminUsersPage() {
  const { load } = useMyData(fetchAdminUsers, 'Users could not be loaded.');

  if (load.status === 'loading') return <p role="status">Loading users…</p>;
  if (load.status === 'error') return <p role="alert">{load.message}</p>;

  const { users } = load.data;

  return (
    <section aria-labelledby="admin-users-heading">
      <h2 id="admin-users-heading">Users</h2>
      {users.length === 0 ? (
        <p>No users yet.</p>
      ) : (
        <>
          <p>
            {users.length} user{users.length === 1 ? '' : 's'}.
          </p>
          <ul aria-label="Users">
            {users.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function UserRow({ user }: { user: AdminUserSummaryDto }) {
  return (
    <li>
      <Link to={`/admin/users/${user.id}`}>{user.displayName ?? user.email ?? user.id}</Link> —{' '}
      {user.role} — {user.hasActiveSubscription ? 'subscribed' : 'not subscribed'} —{' '}
      {user.charityName ?? 'no charity'} — {user.scoreCount} score
      {user.scoreCount === 1 ? '' : 's'}
    </li>
  );
}
