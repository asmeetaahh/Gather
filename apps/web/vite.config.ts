import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the web app (5173) proxies /api to the Express API (4000), so the browser
// stays same-origin and no CORS setup is needed locally.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  test: {
    environment: 'jsdom',
  },
});
