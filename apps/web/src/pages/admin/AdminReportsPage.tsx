import { formatMinorUnits } from '@gather/shared';
import { fetchAdminReports } from '../../api/admin';
import { useMyData } from '../../lib/useMyData';

/**
 * Reports & analytics (PRD §11 ADM-07). Every figure is a LIVE count derived from already-stored
 * facts (`AdminReportsDto`) — nothing here is estimated or fabricated. Exact metric definitions were
 * left open by the PRD (D-029) and are documented as chosen in DECISIONS D-074. There is no refund,
 * chargeback or payout reporting — those systems are not built (see CLAUDE.md), so no such figures
 * are shown, rather than invented.
 */
export function AdminReportsPage() {
  const { load } = useMyData(fetchAdminReports, 'Reports could not be loaded.');

  if (load.status === 'loading') return <p role="status">Loading reports…</p>;
  if (load.status === 'error') return <p role="alert">{load.message}</p>;

  const { reports } = load.data;

  return (
    <section aria-labelledby="admin-reports-heading">
      <h2 id="admin-reports-heading">Reports</h2>

      <div className="dashboard-grid">
        <article aria-labelledby="admin-reports-users-heading">
          <h3 id="admin-reports-users-heading">Users</h3>
          <dl>
            <dt>Total users</dt>
            <dd>{reports.totalUsers}</dd>
            <dt>Active subscribers</dt>
            <dd>{reports.activeSubscribers}</dd>
          </dl>
        </article>

        <article aria-labelledby="admin-reports-draws-heading">
          <h3 id="admin-reports-draws-heading">Draws</h3>
          <dl>
            <dt>Total</dt>
            <dd>{reports.draws.total}</dd>
            <dt>Draft</dt>
            <dd>{reports.draws.draft}</dd>
            <dt>Simulated</dt>
            <dd>{reports.draws.simulated}</dd>
            <dt>Published</dt>
            <dd>{reports.draws.published}</dd>
          </dl>
        </article>

        <article aria-labelledby="admin-reports-pool-heading">
          <h3 id="admin-reports-pool-heading">Prize pool (published draws)</h3>
          {reports.prizePoolByCurrency.length === 0 ? (
            <p>No published draws yet.</p>
          ) : (
            <ul aria-label="Prize pool by currency">
              {reports.prizePoolByCurrency.map((p) => (
                <li key={p.currency}>{formatMinorUnits(p.amountMinor, p.currency)}</li>
              ))}
            </ul>
          )}
        </article>

        <article aria-labelledby="admin-reports-contributions-heading">
          <h3 id="admin-reports-contributions-heading">Charity contributions</h3>
          {reports.charityContributionsByCurrency.length === 0 ? (
            <p>No contributions recorded yet.</p>
          ) : (
            <ul aria-label="Charity contributions by currency">
              {reports.charityContributionsByCurrency.map((c) => (
                <li key={c.currency}>{formatMinorUnits(c.amountMinor, c.currency)}</li>
              ))}
            </ul>
          )}
        </article>

        <article aria-labelledby="admin-reports-winners-heading">
          <h3 id="admin-reports-winners-heading">Winners</h3>
          <dl>
            <dt>Total</dt>
            <dd>{reports.winners.total}</dd>
            <dt>Awaiting proof</dt>
            <dd>{reports.winners.awaitingProof}</dd>
            <dt>Pending review</dt>
            <dd>{reports.winners.pendingReview}</dd>
            <dt>Approved</dt>
            <dd>{reports.winners.approved}</dd>
            <dt>Rejected</dt>
            <dd>{reports.winners.rejected}</dd>
            <dt>Paid</dt>
            <dd>{reports.winners.paid}</dd>
          </dl>
        </article>
      </div>

      <p className="admin-note">
        Live figures, computed just now (generated at{' '}
        {new Date(reports.generatedAt).toLocaleString()}
        ). Refunds, chargebacks and payouts are not tracked by this system, so no such figures
        appear here.
      </p>
    </section>
  );
}
