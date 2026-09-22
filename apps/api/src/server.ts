import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createSupabaseDeps } from './supabase-deps.js';

const config = loadConfig();

if (config.stripe === null) {
  console.warn(
    'STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are not set: checkout, billing and webhooks answer 503.',
  );
}

if (!config.supabase) {
  console.warn(
    'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set: authenticated routes will answer 503.',
  );
}

const app = createApp(
  config,
  config.supabase
    ? createSupabaseDeps(config.supabase, { stripe: config.stripe, webOrigin: config.webOrigin })
    : {},
);

const server = app.listen(config.port, () => {
  console.log(
    `GATHER API listening on http://localhost:${String(config.port)} (${config.nodeEnv})`,
  );
});

// Stop accepting connections and let in-flight requests finish before exiting.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
