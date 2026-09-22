import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import {
  API_ADMIN_BASE_PATH,
  API_ADMIN_DRAWS_PATH,
  API_ADMIN_WINNERS_PATH,
  API_CHARITIES_PATH,
  API_CHARITY_SPOTLIGHT_PATH,
  API_HEALTH_PATH,
  API_ME_PATH,
  API_MY_CHARITY_PATH,
  API_MY_CONTRIBUTIONS_PATH,
  API_MY_SUBSCRIPTION_PATH,
  API_MY_WINNERS_PATH,
  API_PLANS_PATH,
  API_SCORES_PATH,
  API_STRIPE_WEBHOOK_PATH,
} from '@gather/shared';
import { requireAdmin, requireAuth, type AuthDeps } from './auth/middleware.js';
import type { ApiConfig } from './config.js';
import {
  createMyCharityRouter,
  createMyContributionsRouter,
  createPublicCharitiesRouter,
  createSpotlightRouter,
} from './charities/routes.js';
import type { CharityService } from './charities/service.js';
import {
  createMySubscriptionRouter,
  createPlansRouter,
  stripeWebhookRoute,
} from './billing/routes.js';
import type { BillingService } from './billing/service.js';
import type { StripeWebhookHandler } from './billing/webhooks.js';
import { createDrawsAdminRouter } from './draws/routes.js';
import type { DrawService } from './draws/service.js';
import { AppError } from './errors.js';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { createScoresRouter } from './scores/routes.js';
import type { ScoreService } from './scores/service.js';
import { createMyWinnersRouter, createWinnersAdminRouter } from './winners/routes.js';
import type { WinnerService } from './winners/service.js';

export interface AppDeps {
  /** Authentication dependencies. When absent, every authenticated route answers 503. */
  auth?: AuthDeps;
  /** Score use-cases. When absent, the score endpoints answer 503 (after authentication). */
  scores?: ScoreService;
  /** Charity use-cases. When absent, the charity endpoints answer 503. */
  charities?: CharityService;
  /** Plans, the user's subscription, Checkout and the Billing Portal. When absent, those endpoints answer 503. */
  billing?: BillingService;
  /** Verifies and processes Stripe's webhooks. When absent (Stripe not configured), the webhook answers 503. */
  stripeWebhook?: StripeWebhookHandler;
  /** Draw management (PRD §06/§07). When absent, the admin draw endpoints answer 503. */
  draws?: DrawService;
  /** Winner verification and payout tracking (PRD §09/§11). When absent, those endpoints answer 503. */
  winners?: WinnerService;
}

/** Stand-in for a feature whose dependencies were not supplied: refuse rather than guess. */
const unavailable: RequestHandler = () => {
  throw new AppError(503, 'service_unavailable', 'This service is not available right now.');
};

/**
 * Builds the Express app without starting a listener, so tests can drive it in-process.
 * `server.ts` is the only place that binds a port.
 */
export function createApp(config: ApiConfig, deps: AppDeps = {}): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: config.webOrigin }));

  // Stripe's webhook needs the RAW request body (the signature is over the exact bytes), so it is mounted with
  // express.raw() BEFORE the JSON parser. It is authenticated by its signature, not by a session (D-068).
  app.post(
    API_STRIPE_WEBHOOK_PATH,
    express.raw({ type: () => true, limit: '1mb' }),
    stripeWebhookRoute(deps.stripeWebhook),
  );

  app.use(express.json({ limit: '100kb' }));

  // Public.
  app.use(API_HEALTH_PATH, healthRouter);

  // Charities. The directory and spotlight are PUBLIC (PRD §03: visitors explore listed charities).
  app.use(
    API_CHARITIES_PATH,
    deps.charities ? createPublicCharitiesRouter(deps.charities) : unavailable,
  );
  app.use(
    API_CHARITY_SPOTLIGHT_PATH,
    deps.charities ? createSpotlightRouter(deps.charities) : unavailable,
  );

  // Plans are public: visitors may look before they sign up. The user's own subscription needs sign-in.
  app.use(API_PLANS_PATH, deps.billing ? createPlansRouter(deps.billing) : unavailable);
  app.use(
    API_MY_SUBSCRIPTION_PATH,
    requireAuth(deps.auth),
    deps.billing ? createMySubscriptionRouter(deps.billing) : unavailable,
  );

  // The signed-in user's own charity choice and contributions. Mounted BEFORE the generic /api/me so these
  // paths are authenticated exactly once.
  app.use(
    API_MY_CHARITY_PATH,
    requireAuth(deps.auth),
    deps.charities ? createMyCharityRouter(deps.charities) : unavailable,
  );
  app.use(
    API_MY_CONTRIBUTIONS_PATH,
    requireAuth(deps.auth),
    deps.charities ? createMyContributionsRouter(deps.charities) : unavailable,
  );
  // The signed-in user's own winnings (PRD §10 DSH-05). Mounted BEFORE the generic /api/me for the
  // same reason as charity/contributions above.
  app.use(
    API_MY_WINNERS_PATH,
    requireAuth(deps.auth),
    deps.winners ? createMyWinnersRouter(deps.winners) : unavailable,
  );

  // Authenticated: any signed-in account, acting only as itself.
  app.use(API_ME_PATH, requireAuth(deps.auth), meRouter);

  // Scores: a signed-in user managing their OWN scores (ownership comes from the verified token).
  app.use(
    API_SCORES_PATH,
    requireAuth(deps.auth),
    deps.scores ? createScoresRouter(deps.scores) : unavailable,
  );

  // Administrators only. The guards are mounted on the PREFIX, so they run before routing: even an
  // unknown /api/admin/* path answers 401/403 (never a revealing 404) until the caller is an admin.
  app.use(
    API_ADMIN_DRAWS_PATH,
    requireAuth(deps.auth),
    requireAdmin,
    deps.draws ? createDrawsAdminRouter(deps.draws) : unavailable,
  );
  app.use(
    API_ADMIN_WINNERS_PATH,
    requireAuth(deps.auth),
    requireAdmin,
    deps.winners ? createWinnersAdminRouter(deps.winners) : unavailable,
  );
  app.use(API_ADMIN_BASE_PATH, requireAuth(deps.auth), requireAdmin, adminRouter);

  // Order matters: unmatched /api routes -> JSON 404, then the final error handler.
  app.use('/api', apiNotFound);
  app.use(errorHandler);

  return app;
}
