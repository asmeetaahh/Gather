import { isYearlyDiscounted, type BillingInterval } from '@gather/shared';
import type { PaymentGateway, ProviderPrice } from './gateway.js';
import type { BillingRepository, PlanRecord } from './repository.js';
import { HANDLED_EVENT_TYPES } from './webhooks.js';

/**
 * A READ-ONLY readiness check for hosted Stripe verification. It changes nothing: it compares the `plans` rows with
 * the Stripe prices they point at, and confirms the billing SQL from migration …140000 is present. Run it before
 * trusting a setup — a plan row whose Stripe price charges a different amount or currency would be displayed at one
 * price and billed at another, and no other test can see that.
 *
 * Prices and currency are CONFIGURATION (Stripe + the `plans` table), not requirements or code (OWNER D-070): this check
 * never assumes a value, it only checks that the two sides of the configuration agree.
 */

export type FindingLevel = 'ok' | 'warning' | 'error';

export interface Finding {
  level: FindingLevel;
  check: string;
  message: string;
}

/** The result of looking a price up at Stripe: the price, or why it could not be read. */
export type PriceLookup = { price: ProviderPrice } | { error: string };

const NIL_UUID = '00000000-0000-4000-8000-000000000000';

const EXPECTED_INTERVAL: Record<BillingInterval, string> = { month: 'month', year: 'year' };

/** Pure: compares the active plans with the Stripe prices they name. */
export function checkPlanCatalogue(
  plans: PlanRecord[],
  lookups: ReadonlyMap<string, PriceLookup>,
): Finding[] {
  const findings: Finding[] = [];
  const add = (level: FindingLevel, check: string, message: string) =>
    findings.push({ level, check, message });

  for (const interval of ['month', 'year'] as const) {
    if (!plans.some((p) => p.interval === interval)) {
      add(
        'error',
        `plan:${interval}`,
        `There is no active ${interval === 'month' ? 'monthly' : 'yearly'} plan (PRD SUB-01 needs both).`,
      );
    }
  }

  for (const plan of plans) {
    const check = `plan:${plan.interval}`;
    if (!plan.stripePriceId) {
      add('error', check, `"${plan.name}" has no stripe_price_id, so it cannot be sold.`);
      continue;
    }
    const lookup = lookups.get(plan.stripePriceId);
    if (!lookup) {
      add('error', check, `"${plan.name}": the Stripe price was not looked up.`);
      continue;
    }
    if ('error' in lookup) {
      add(
        'error',
        check,
        `"${plan.name}": Stripe price ${plan.stripePriceId} could not be read (${lookup.error}).`,
      );
      continue;
    }
    const { price } = lookup;
    const problems: string[] = [];
    if (!price.active) problems.push('the Stripe price is not active');
    if (price.livemode) problems.push('it is a LIVE-mode price (only test mode is allowed)');
    if (price.type !== 'recurring')
      problems.push(`it is a "${price.type}" price, not a recurring one`);
    if (price.interval !== EXPECTED_INTERVAL[plan.interval] || price.intervalCount !== 1) {
      problems.push(
        `it bills every ${String(price.intervalCount)} ${String(price.interval)}(s), but the plan is ${plan.interval}ly`,
      );
    }
    if (price.currency.toUpperCase() !== plan.currency.toUpperCase()) {
      problems.push(`its currency is ${price.currency} but the plan says ${plan.currency}`);
    }
    if (price.unitAmount !== plan.amountMinor) {
      problems.push(
        `it charges ${String(price.unitAmount)} but the plan says ${String(plan.amountMinor)} (minor units)`,
      );
    }
    if (problems.length > 0) add('error', check, `"${plan.name}": ${problems.join('; ')}.`);
    else
      add(
        'ok',
        check,
        `"${plan.name}" matches its Stripe price (${plan.amountMinor} ${plan.currency}, ${plan.interval}ly).`,
      );
  }

  const monthly = plans.find((p) => p.interval === 'month');
  const yearly = plans.find((p) => p.interval === 'year');
  if (monthly && yearly) {
    if (isYearlyDiscounted(monthly, yearly)) {
      add('ok', 'discount', 'The yearly plan is a discount on 12 monthly payments (PRD SUB-01).');
    } else {
      add(
        'error',
        'discount',
        'The yearly plan is not cheaper than 12 monthly payments (or is in another currency): it will NOT be offered.',
      );
    }
  }
  return findings;
}

export interface PreflightDeps {
  repository: Pick<BillingRepository, 'listActivePlans' | 'hasOpenSubscription'>;
  gateway: Pick<PaymentGateway, 'retrievePrice'>;
}

/** Looks everything up (read-only) and returns the findings. */
export async function runPreflight({ repository, gateway }: PreflightDeps): Promise<Finding[]> {
  const findings: Finding[] = [];

  // The database side: migration …140000 must be applied. A missing function makes this call fail.
  try {
    await repository.hasOpenSubscription(NIL_UUID);
    findings.push({
      level: 'ok',
      check: 'database',
      message: 'The billing SQL (migration …140000) is present.',
    });
  } catch {
    findings.push({
      level: 'error',
      check: 'database',
      message: 'The billing SQL is missing — apply migration …140000 (`supabase db push`).',
    });
  }

  let plans: PlanRecord[];
  try {
    plans = await repository.listActivePlans();
  } catch {
    findings.push({ level: 'error', check: 'plans', message: 'The plans could not be read.' });
    return findings;
  }

  const lookups = new Map<string, PriceLookup>();
  await Promise.all(
    plans.map(async (plan) => {
      if (!plan.stripePriceId) return;
      try {
        lookups.set(plan.stripePriceId, { price: await gateway.retrievePrice(plan.stripePriceId) });
      } catch {
        lookups.set(plan.stripePriceId, { error: 'not found, or Stripe could not be reached' });
      }
    }),
  );
  findings.push(...checkPlanCatalogue(plans, lookups));

  findings.push({
    level: 'ok',
    check: 'webhook',
    message: `Enable these events on the webhook endpoint (or \`stripe listen --events\`): ${HANDLED_EVENT_TYPES.join(', ')}.`,
  });
  return findings;
}

export const hasErrors = (findings: Finding[]): boolean =>
  findings.some((f) => f.level === 'error');
