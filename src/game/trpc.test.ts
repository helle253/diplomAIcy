import { describe, expect, it } from 'vitest';

import { createContext } from './trpc.js';

type MockReq = {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
};

describe('createContext', () => {
  it('extracts bearer token from Authorization header', () => {
    const req: MockReq = { headers: { authorization: 'Bearer my-token' } };
    const ctx = createContext({ req });
    expect(ctx.token).toBe('my-token');
  });

  it('extracts token from query param', () => {
    const req: MockReq = { headers: {}, url: '/trpc?token=my-token' };
    const ctx = createContext({ req });
    expect(ctx.token).toBe('my-token');
  });

  it('returns null token when no auth provided', () => {
    const req: MockReq = { headers: {} };
    const ctx = createContext({ req });
    expect(ctx.token).toBeNull();
  });

  it('prefers Authorization header over query param', () => {
    const req: MockReq = {
      headers: { authorization: 'Bearer header-token' },
      url: '/trpc?token=query-token',
    };
    const ctx = createContext({ req });
    expect(ctx.token).toBe('header-token');
  });
});
