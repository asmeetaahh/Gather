import { Router, type Request, type RequestHandler } from 'express';
import {
  parseCreateCheckoutRequest,
  type ListPlansResponse,
  type RedirectResponse,
  type SubscriptionResponse,
} from '@gather/shared';
import { AppError, ValidationError } from '../errors.js';
import { WebhookSignatureError } from './gateway.js';
import type { BillingService } from './service.js';
import { InvalidStripeEventError } from './stripe-events.js';
import type { StripeWebhookHandler } from './webhooks.js';

/** The id of the verified caller (set by `requireAuth`); if it is missing the guard was skipped, so refuse. */
function caller(req: Request): { userId: string; email: string | null } {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required.');
  return { userId: auth.userId, email: auth.email };
}

/** `GET /api/plans` — the plans that can be bought right now. Public (visitors may "initiate subscription"). */
export function createPlansRouter(service: BillingService): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    const body: ListPlansResponse = { plans: await service.listPlans() };
    res.json(body);
  });
  return router;
}

/**
 * The signed-in user's subscription — mounted behind `requireAuth`. The user id comes only from the verified
 * token, so a `userId` (or a price, an amount, a charity) in a body or query is ignored: the plan is chosen by
 * `interval` alone and the charity is the user's own stored choice.
 */
export function createMySubscriptionRouter(service: BillingService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const body: SubscriptionResponse = await service.getSubscription(caller(req).userId);
    res.json(body);
  });

  router.post('/checkout', async (req, res) => {
    const input = parseCreateCheckoutRequest(req.body);
    // `Parsed<T>` narrows on `ok`, but negating `!input.ok` does not always narrow it in every
    // toolchain (seen as TS2339 "Property 'errors' does not exist on type 'Parsed<T>'"). Narrowing on
    // the `errors` property itself — which only the failure variant has — is equivalent at runtime
    // (a parse either produced errors or a value, never neither/both) and narrows reliably either way.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: RedirectResponse = await service.startCheckout(caller(req), input.value.interval);
    res.json(body);
  });

  router.post('/portal', async (req, res) => {
    const body: RedirectResponse = await service.openPortal(caller(req).userId);
    res.json(body);
  });

  return router;
}

/**
 * `POST /api/webhooks/stripe`. It must be mounted with `express.raw()` and BEFORE `express.json()`: the signature
 * is computed over the exact bytes Stripe sent, and re-serialised JSON would never match. No authentication
 * middleware applies — the signature is the authentication.
 *
 * Answers: 200 for anything applied, ignored, duplicated or that can never be applied (so Stripe stops retrying);
 * 400 for a bad signature or an unreadable event; 503 when Stripe is not configured; 500 (generic) when a
 * transient failure means Stripe should deliver it again.
 */
export function stripeWebhookRoute(handler: StripeWebhookHandler | undefined): RequestHandler {
  return async (req, res) => {
    if (!handler) {
      throw new AppError(503, 'service_unavailable', 'This service is not available right now.');
    }
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError(400, 'invalid_webhook', 'The request could not be processed.');
    }
    try {
      const outcome = await handler.handle(body, req.get('stripe-signature'));
      res.json({ received: true, outcome });
    } catch (error) {
      // No detail about WHY: a caller that is not Stripe learns nothing about what we check.
      if (error instanceof WebhookSignatureError || error instanceof InvalidStripeEventError) {
        throw new AppError(400, 'invalid_webhook', 'The request could not be processed.');
      }
      throw error;
    }
  };
}
