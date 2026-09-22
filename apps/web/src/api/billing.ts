import {
  API_MY_CHECKOUT_PATH,
  API_MY_PORTAL_PATH,
  API_MY_SUBSCRIPTION_PATH,
  API_PLANS_PATH,
  type BillingInterval,
  type ListPlansResponse,
  type RedirectResponse,
  type SubscriptionResponse,
} from '@gather/shared';
import { apiRequest } from './client';

/** `GET /api/plans` — the plans that can be bought (public). */
export const fetchPlans = (signal?: AbortSignal) =>
  apiRequest<ListPlansResponse>(API_PLANS_PATH, { ...(signal && { signal }) });

/** `GET /api/me/subscription` — the signed-in user's subscription. */
export const fetchMySubscription = (accessToken: string) =>
  apiRequest<SubscriptionResponse>(API_MY_SUBSCRIPTION_PATH, { accessToken });

/** `POST /api/me/subscription/checkout` — returns Stripe's hosted Checkout page to send the browser to. */
export const startCheckout = (accessToken: string, interval: BillingInterval) =>
  apiRequest<RedirectResponse>(API_MY_CHECKOUT_PATH, {
    method: 'POST',
    accessToken,
    body: { interval },
  });

/** `POST /api/me/subscription/portal` — returns Stripe's Billing Portal page. */
export const openBillingPortal = (accessToken: string) =>
  apiRequest<RedirectResponse>(API_MY_PORTAL_PATH, { method: 'POST', accessToken });
