import type { AppDeps } from './app.js';
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
  const gateway = options.stripe ? createStripeGatewayFromConfig(options.stripe) : null;

  return {
    auth: {
      verifier: createSupabaseTokenVerifier(config.url),
      profiles: createSupabaseProfileRepository(client),
    },
    scores: createScoreService({
      repository: createSupabaseScoreRepository(client),
      subscriptions: createSupabaseSubscriptionGate(client),
    }),
    charities,
    // Checkout calls the charity domain's precondition before it creates anything at Stripe (D-066).
    billing: createBillingService({
      repository: billingRepository,
      gateway,
      charities,
      webOrigin: options.webOrigin,
    }),
    draws: createDrawService({ repository: createSupabaseDrawRepository(client) }),
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
