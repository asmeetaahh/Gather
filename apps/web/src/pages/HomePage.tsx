import { Link } from 'react-router-dom';
import { formatPercent, MIN_CHARITY_BPS } from '@gather/shared';
import { CharitySpotlight } from './CharitySpotlight';

/**
 * Public marketing homepage (PRD §12 UX-04: "clearly communicates what the user does, how they win,
 * charity impact, and the call to action"; UX-01 "feel, not fairway" — leads with charitable impact,
 * not the sport). Every claim here is a PRD-confirmed fact (monthly cadence, 5/4/3-number tiers, only
 * the 5-match jackpot rolls over, 10% minimum charity share) — nothing invents a prize-pool
 * percentage, a jackpot amount, a live subscriber count, a draw schedule or a Stripe outcome, since
 * none of those are decided or available yet.
 */
export function HomePage() {
  return (
    <>
      <section className="hero" aria-labelledby="home-hero-heading">
        <p className="eyebrow">Golf performance · monthly prize draws · real charity impact</p>
        <h1 id="home-hero-heading">GATHER</h1>
        <p className="hero-tagline">
          Log your rounds, get entered into a monthly prize draw, and turn every subscription into
          support for a charity you choose.
        </p>
        <div className="hero-cta">
          {/* Distinct wording from the nav's own "Sign up" link, so both are unambiguous
              assistive-tech targets on the same page. */}
          <Link to="/signup" className="btn btn-primary">
            Get started
          </Link>
          <Link to="/charities" className="btn btn-secondary">
            View charities
          </Link>
        </div>
      </section>

      <section aria-labelledby="how-it-works-heading" className="loop">
        <h2 id="how-it-works-heading">How Gather works</h2>
        <ol className="loop-steps">
          <li>
            <h3>Enter your scores</h3>
            <p>Keep your last five Stableford rounds on record — add one any time you play.</p>
          </li>
          <li>
            <h3>Get entered in the draw</h3>
            <p>Every active subscriber is entered in that month's prize draw automatically.</p>
          </li>
          <li>
            <h3>Win a prize</h3>
            <p>Match 5, 4 or 3 numbers in the draw to win a share of that month's prize pool.</p>
          </li>
          <li>
            <h3>Give back</h3>
            <p>
              A share of every subscription goes straight to the charity you chose — win or not.
            </p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="prizes-heading" className="prizes">
        <h2 id="prizes-heading">Three ways to win</h2>
        <p>Every monthly draw pays out across three tiers:</p>
        <div className="prize-tiers">
          <article>
            <h3>5-number match</h3>
            <p>The jackpot tier. If nobody wins it, it rolls over into next month's pool.</p>
          </article>
          <article>
            <h3>4-number match</h3>
            <p>A share of that month's pool for matching four numbers.</p>
          </article>
          <article>
            <h3>3-number match</h3>
            <p>A share of that month's pool for matching three numbers.</p>
          </article>
        </div>
        <p className="admin-note">
          Draws run monthly. Prize amounts depend on that month's pool and are only shown once a
          draw is published — nothing here is a guaranteed figure.
        </p>
      </section>

      <section aria-labelledby="charity-heading" className="charity-impact">
        <h2 id="charity-heading">Your subscription gives back</h2>
        <p>
          At signup you choose the charity your subscription supports. At least{' '}
          {formatPercent(MIN_CHARITY_BPS)} of every payment goes to them, and you can increase that
          share any time from your account.
        </p>
        <p>
          <Link to="/charities">Browse the charity directory &rarr;</Link>
        </p>
      </section>

      <CharitySpotlight />

      <section aria-labelledby="final-cta-heading" className="final-cta">
        <h2 id="final-cta-heading">Ready to play for good?</h2>
        <p>Join Gather, enter this month's draw, and start giving back with every round.</p>
        <Link to="/signup" className="btn btn-primary">
          Sign up now
        </Link>
      </section>
    </>
  );
}
