/**
 * Leaves the app for another site (Stripe's hosted Checkout or Billing Portal). Card details are entered there,
 * never in this app. Kept in one tiny module so tests can replace it: a full-page navigation cannot happen in them.
 */
export function goTo(url: string): void {
  window.location.assign(url);
}
