import type { SupabaseClient } from '@supabase/supabase-js';

export interface StubResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** A chainable stand-in for supabase-js's query builder: records each call, resolves to a canned result. */
export class QueryStub implements PromiseLike<StubResult> {
  readonly calls: string[] = [];
  constructor(private readonly result: StubResult) {}
  private record(call: string): this {
    this.calls.push(call);
    return this;
  }
  select(columns: string) {
    return this.record(`select(${columns})`);
  }
  eq(column: string, value: unknown) {
    return this.record(`eq(${column}=${String(value)})`);
  }
  is(column: string, value: unknown) {
    return this.record(`is(${column}=${String(value)})`);
  }
  gte(column: string, value: unknown) {
    return this.record(`gte(${column}>=${String(value)})`);
  }
  contains(column: string, value: unknown) {
    return this.record(`contains(${column}=${JSON.stringify(value)})`);
  }
  textSearch(column: string, query: string, options: { config?: string }) {
    return this.record(`textSearch(${column}:${query}|${options.config ?? ''})`);
  }
  order(column: string, options: { ascending: boolean; referencedTable?: string }) {
    return this.record(
      `order(${options.referencedTable ? `${options.referencedTable}.` : ''}${column},${options.ascending ? 'asc' : 'desc'})`,
    );
  }
  range(from: number, to: number) {
    return this.record(`range(${String(from)},${String(to)})`);
  }
  limit(count: number, options?: { referencedTable?: string }) {
    return this.record(
      `limit(${options?.referencedTable ? `${options.referencedTable}.` : ''}${String(count)})`,
    );
  }
  update(values: unknown) {
    return this.record(`update(${JSON.stringify(values)})`);
  }
  maybeSingle(): Promise<StubResult> {
    this.calls.push('maybeSingle()');
    return Promise.resolve(this.result);
  }
  then<A = StubResult, B = never>(
    onfulfilled?: ((value: StubResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

/** A supabase-js client whose `from()` returns a recording stub and whose storage URLs are deterministic. */
export function stubClient(result: StubResult) {
  const seen: { table?: string; query?: QueryStub; bucket?: string } = {};
  const client = {
    from(table: string) {
      seen.table = table;
      seen.query = new QueryStub(result);
      return seen.query;
    },
    storage: {
      from(bucket: string) {
        seen.bucket = bucket;
        return {
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
  } as unknown as SupabaseClient;
  return { client, seen };
}
