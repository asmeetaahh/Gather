import { describe, expect, it } from 'vitest';
import { request } from './test-support/http.js';
import { API_HEALTH_PATH, type HealthResponse } from '@gather/shared';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const app = createApp(loadConfig({ NODE_ENV: 'test' }));

describe('GET /api/health', () => {
  it('confirms the API is running', async () => {
    const res = await request(app).get(API_HEALTH_PATH);

    const body = res.body as HealthResponse;

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(body).toMatchObject({ status: 'ok', service: 'gather-api' });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});

describe('error handling', () => {
  it('returns a JSON 404 for unknown /api routes', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Resource not found.' } });
  });

  it('returns a JSON 400 for malformed JSON bodies without leaking details', async () => {
    const res = await request(app)
      .post(API_HEALTH_PATH)
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'bad_request', message: 'The request could not be processed.' },
    });
  });
});
