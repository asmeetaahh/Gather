import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Booting PostgreSQL (WASM) and applying every migration takes a few seconds per file.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
