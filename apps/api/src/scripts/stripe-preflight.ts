import { createServiceClient } from '../auth/profiles.js';
import { createStripeGatewayFromConfig } from '../billing/gateway.js';
import { hasErrors, runPreflight } from '../billing/preflight.js';
import { createSupabaseBillingRepository } from '../billing/repository.js';
import { loadConfig } from '../config.js';

/**
 * `npm run preflight:stripe -w @gather/api` — a READ-ONLY readiness check for hosted Stripe verification. It reads
 * `apps/api/.env`, looks at the `plans` table and at the Stripe prices they name, and prints whether they agree. It
 * writes nothing anywhere, and never prints a key. Exit code 1 if anything is wrong, 2 if the environment is not set up.
 */
const config = loadConfig();
if (!config.supabase || !config.stripe) {
  console.error(
    'Not ready: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY (sk_test_…) and STRIPE_WEBHOOK_SECRET in apps/api/.env.',
  );
  process.exit(2);
}

const findings = await runPreflight({
  repository: createSupabaseBillingRepository(createServiceClient(config.supabase)),
  gateway: createStripeGatewayFromConfig(config.stripe),
});
for (const f of findings)
  console.log(`${f.level.toUpperCase().padEnd(7)} ${f.check.padEnd(11)} ${f.message}`);
console.log(
  hasErrors(findings) ? '\nNOT READY — fix the errors above.' : '\nReady for hosted verification.',
);
process.exit(hasErrors(findings) ? 1 : 0);
