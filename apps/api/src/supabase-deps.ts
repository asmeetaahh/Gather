import type { AppDeps } from './app.js';
import { createSupabaseAdminUserRepository } from './admin/users/repository.js';
import { createAdminUserService } from './admin/users/service.js';
import { createSupabaseAdminReportsRepository } from './admin/reports/repository.js';
import { createAdminReportsService } from './admin/reports/service.js';
import { createSupabaseSubscriptionGate } from './auth/entitlement.js';
import { createServiceClient, createSupabaseProfileRepository } from './auth/profiles.js';
import { createSupabaseTokenVerifier } from './auth/verifier.js';
import { createStripeGatewayFromConfig } from './billing/gateway.js';
import { createSupabaseBillingRepository } from './billing/repository.js';
import { createCharitySelectionReader } from './billing/selection.js';
import { createBillingService } from './billing/service.js';
import { createStripeWebhookHandler, createWebhookProcessor } from './billing/webhooks.js';
import { createSupabaseCharityRepository } from './charities/repository.js';
import { createCharityService } from './charities/service.js';
import type { StripeConfig, SupabaseConfig } from './config.js';
import { createSupabaseDrawRepository } from './draws/repository.js';
import { createDrawService } from './draws/service.js';
import { createSupabaseScoreRepository } from './scores/repository.js';
import { createScoreService } from './scores/service.js';
import { createSupabaseWinnerRepository } from './winners/repository.js';
import { createWinnerService } from './winners/service.js';

export interface DepsOptions {
  /** Stripe (test mode), or null: checkout, the billing portal and the webhook then answer 503. */
  stripe: StripeConfig | null;
  /** The web app's origin, for Checkout's return URLs. */
  webOrigin: string;
}

/**
 * Wires the API to a real Supabase project: its published token keys, and every repository through ONE
 * service-role client (server-side only). This is the single composition root for production wiring.
 */
export function createSupabaseDeps(config: SupabaseConfig, options: DepsOptions): AppDeps {
  const client = createServiceClient(config);
  const charityRepository = createSupabaseCharityRepository(client);
  const charities = createCharityService({ repository: charityRepository });
  const billingRepository = createSupabaseBillingRepository(client);
  const drawRepository = createSupabaseDrawRepository(client);
  const winnerRepository = createSupabaseWinnerRepository(client);
  const scores = createScoreService({
    repository: createSupabaseScoreRepository(client),
    subscriptions: createSupabaseSubscriptionGate(client),
  });
  const gateway = options.stripe ? createStripeGatewayFromConfig(options.stripe) : null;

  return {
    auth: {
      verifier: createSupabaseTokenVerifier(config.url),
      profiles: createSupabaseProfileRepository(client),
    },
    scores,
    charities,
    // Checkout calls the charity domain's precondition before it creates anything at Stripe (D-066).
    billing: createBillingService({
      repository: billingRepository,
      gateway,
      charities,
      webOrigin: options.webOrigin,
    }),
    draws: createDrawService({ repository: drawRepository }),
    winners: createWinnerService({ repository: winnerRepository }),
    // Admin user management (PRD §11 ADM-01) REUSES the same scores/charities/billing/winners
    // repositories/services above — no second copy of any of those rules (D-074).
    adminUsers: createAdminUserService({
      users: createSupabaseAdminUserRepository(client),
      scores,
      charities: charityRepository,
      billing: billingRepository,
      winners: winnerRepository,
    }),
    adminReports: createAdminReportsService({
      reports: createSupabaseAdminReportsRepository(client),
      draws: drawRepository,
      winners: winnerRepository,
    }),
    ...(gateway && {
      stripeWebhook: createStripeWebhookHandler(
        gateway,
        createWebhookProcessor({
          repository: billingRepository,
          gateway,
          selection: createCharitySelectionReader(charityRepository),
        }),
      ),
    }),
  };
}
