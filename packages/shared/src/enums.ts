/**
 * Value sets of the PostgreSQL enum types defined in supabase/migrations. The database is the
 * source of truth; these mirrors let the web and api apps share the vocabulary. A database test
 * (supabase/tests) fails if this file and the migrated schema ever disagree.
 *
 * Full table row types are NOT hand-written here: once the Supabase CLI is available they
 * should be generated (`supabase gen types typescript`) rather than duplicated by hand.
 */

export const APP_ROLES = ['user', 'admin'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const SUBSCRIPTION_STATUSES = ['pending', 'active', 'cancelled', 'lapsed'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PAYMENT_KINDS = ['subscription', 'donation'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATES = ['pending', 'succeeded', 'failed', 'refunded'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const DRAW_MODES = ['random', 'algorithmic'] as const;
export type DrawMode = (typeof DRAW_MODES)[number];

export const DRAW_STATUSES = ['draft', 'simulated', 'published'] as const;
export type DrawStatus = (typeof DRAW_STATUSES)[number];

export const VERIFICATION_STATUSES = [
  'awaiting_proof',
  'pending_review',
  'approved',
  'rejected',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const PAYOUT_STATUSES = ['pending', 'paid'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const STRIPE_EVENT_STATUSES = ['received', 'processed', 'failed'] as const;
export type StripeEventStatus = (typeof STRIPE_EVENT_STATUSES)[number];

/** Enum type name in the `public` schema -> the values mirrored above. */
export const DB_ENUMS = {
  app_role: APP_ROLES,
  billing_interval: BILLING_INTERVALS,
  subscription_status: SUBSCRIPTION_STATUSES,
  payment_kind: PAYMENT_KINDS,
  payment_state: PAYMENT_STATES,
  draw_mode: DRAW_MODES,
  draw_status: DRAW_STATUSES,
  verification_status: VERIFICATION_STATUSES,
  payout_status: PAYOUT_STATUSES,
  stripe_event_status: STRIPE_EVENT_STATUSES,
} as const;

/** Storage bucket ids created by the migrations. */
export const STORAGE_BUCKETS = {
  winnerProofs: 'winner-proofs',
  charityMedia: 'charity-media',
} as const;
