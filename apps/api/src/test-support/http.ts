import type { OutgoingHttpHeaders, RequestListener } from 'node:http';
import inject from 'light-my-request';

/**
 * Test-only: send requests to an Express app IN-PROCESS, with no TCP socket, port or server at all.
 *
 * WHY. The tests used supertest, which starts a real server on a random port for every request. On the
 * development machine that let other local listeners (a VS Code extension helper serving Express on
 * `127.0.0.1`) occasionally answer a request meant for the test server, producing rare, unreproducible
 * empty-body `404`s. Binding the test server to loopback only reduced that (~6x); it could not remove it.
 * `light-my-request` (from the Fastify project) hands the app a synthetic request/response pair directly,
 * so no network stack is involved and nothing outside the process can interfere.
 *
 * This is a thin adapter that keeps supertest's call shape, so tests read exactly as before:
 *
 *     const res = await request(app).post('/api/x').set({ Authorization: '...' }).send({ a: 1 });
 *     res.status; res.body; res.headers; res.text;
 *
 * Behaviour deliberately matches supertest for what the tests rely on: an object/array body is sent as
 * JSON, a string body is sent as-is (form-encoded unless a Content-Type was set), `res.body` is the parsed
 * JSON for JSON responses and `{}` otherwise, and header names are lowercase.
 */

export interface TestResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  /** The raw response body ('' when empty). */
  text: string;
  /** Parsed JSON for JSON responses, `{}` otherwise (like supertest). */
  body: unknown;
}

type HeaderInput = Record<string, string>;

class TestRequest implements PromiseLike<TestResponse> {
  private readonly headers: Record<string, string> = {};
  private payload: unknown;

  constructor(
    private readonly app: RequestListener,
    private readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    private readonly url: string,
  ) {}

  /** Sets one header (`set(name, value)`) or several (`set({ name: value })`). Names are case-insensitive. */
  set(name: string, value: string): this;
  set(headers: HeaderInput): this;
  set(nameOrHeaders: string | HeaderInput, value?: string): this {
    const entries: [string, string][] =
      typeof nameOrHeaders === 'string'
        ? [[nameOrHeaders, value ?? '']]
        : Object.entries(nameOrHeaders);
    for (const [name, headerValue] of entries)
      this.headers[name.toLowerCase()] = String(headerValue);
    return this;
  }

  /** Sets the request body. */
  send(body?: unknown): this {
    this.payload = body;
    return this;
  }

  private async execute(): Promise<TestResponse> {
    const headers = { ...this.headers };
    let payload: string | undefined;
    if (this.payload !== undefined) {
      if (typeof this.payload === 'string') {
        payload = this.payload;
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else {
        payload = JSON.stringify(this.payload);
        headers['content-type'] ??= 'application/json';
      }
    }

    const res = await inject(this.app, {
      method: this.method,
      url: this.url,
      headers,
      ...(payload !== undefined && { payload }),
    });

    const contentType = String(res.headers['content-type'] ?? '');
    let body: unknown = {};
    if (contentType.includes('json') && res.payload !== '') {
      try {
        body = JSON.parse(res.payload);
      } catch {
        body = {};
      }
    }
    return { status: res.statusCode, headers: res.headers, text: res.payload, body };
  }

  then<A = TestResponse, B = never>(
    onfulfilled?: ((value: TestResponse) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/** `request(app).get(url)` / `.post` / `.put` / `.patch` / `.delete`, resolving to a `TestResponse`. */
export function request(app: RequestListener) {
  return {
    get: (url: string) => new TestRequest(app, 'GET', url),
    post: (url: string) => new TestRequest(app, 'POST', url),
    put: (url: string) => new TestRequest(app, 'PUT', url),
    patch: (url: string) => new TestRequest(app, 'PATCH', url),
    delete: (url: string) => new TestRequest(app, 'DELETE', url),
  };
}
