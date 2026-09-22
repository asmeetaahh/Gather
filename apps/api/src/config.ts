/**
 * Runtime configuration for the API, parsed from environment variables.
 *
 * Kept as a pure function of its input so it can be unit-tested without touching
 * `process.env`. Server-only secrets (the Supabase service-role key) must only ever be read in
 * the api app — never in the web app or the shared package.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export interface SupabaseConfig {
  /** Project URL, without a trailing slash, e.g. https://<ref>.supabase.co */
  url: string;
  /** SECRET. Bypasses RLS. Server-side only. */
  serviceRoleKey: string;
}

export interface StripeConfig {
  /** SECRET. A TEST-mode key (`sk_test_…` / `rk_test_…`); live keys are refused (DECISIONS D-068). */
  secretKey: string;
  /** SECRET. The signing secret of the webhook endpoint (`whsec_…`). */
  webhookSecret: string;
}

export interface ApiConfig {
  nodeEnv: NodeEnv;
  port: number;
  /** Origin allowed to call the API from a browser (CORS). */
  webOrigin: string;
  /**
   * Supabase connection, or `null` when not configured. Without it the API still starts (so
   * `/api/health` works) but every authenticated route answers 503 — it never lets a request through.
   */
  supabase: SupabaseConfig | null;
  /**
   * Stripe, or `null` when not configured. Without it the API still starts; checkout, the billing portal and the
   * webhook answer 503, while reading plans and one's own subscription keeps working.
   */
  stripe: StripeConfig | null;
}

const DEFAULT_PORT = 4000;
const DEFAULT_WEB_ORIGIN = 'http://localhost:5173';

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (value === undefined || value === '') return 'development';
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new Error(`Invalid NODE_ENV "${value}". Expected development, test or production.`);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${value}". Expected an integer between 1 and 65535.`);
  }
  return port;
}

function parseSupabase(env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): SupabaseConfig | null {
  const rawUrl = env.SUPABASE_URL?.trim() ?? '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';

  if (rawUrl === '' && serviceRoleKey === '') {
    if (nodeEnv === 'production') {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.');
    }
    return null;
  }
  if (rawUrl === '' || serviceRoleKey === '') {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid SUPABASE_URL. Expected a full URL such as https://<ref>.supabase.co.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Invalid SUPABASE_URL. Expected an http(s) URL.');
  }

  return { url: url.origin, serviceRoleKey };
}

/**
 * Both Stripe secrets, or neither. Only TEST-mode keys are accepted: this integration is built and verified in
 * Stripe test mode, and a live key must never be picked up by accident (ASM-11). Values are never echoed in errors.
 */
function parseStripe(env: NodeJS.ProcessEnv): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';

  if (secretKey === '' && webhookSecret === '') return null;
  if (secretKey === '' || webhookSecret === '') {
    throw new Error('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set together.');
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secretKey)) {
    throw new Error(
      'Invalid STRIPE_SECRET_KEY. Only Stripe TEST-mode keys (sk_test_… or rk_test_…) are accepted.',
    );
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new Error('Invalid STRIPE_WEBHOOK_SECRET. Expected a webhook signing secret (whsec_…).');
  }
  return { secretKey, webhookSecret };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  return {
    nodeEnv,
    port: parsePort(env.PORT),
    webOrigin: env.WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN,
    supabase: parseSupabase(env, nodeEnv),
    stripe: parseStripe(env),
  };
}
