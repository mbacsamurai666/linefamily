import { describe, expect, it } from 'vitest';
import { withConnectionLimit } from '../src/db/client.js';

describe('withConnectionLimit', () => {
  const base = 'postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';

  it('caps a URL that says nothing about its pool', () => {
    expect(withConnectionLimit(base)).toBe(`${base}?connection_limit=5`);
  });

  it('adds to an existing query string rather than starting a second one', () => {
    expect(withConnectionLimit(`${base}?sslmode=require`)).toBe(`${base}?sslmode=require&connection_limit=5`);
  });

  it('leaves an explicit limit alone', () => {
    expect(withConnectionLimit(`${base}?connection_limit=1`)).toBe(`${base}?connection_limit=1`);
  });
});
