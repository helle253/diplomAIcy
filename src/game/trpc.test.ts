import { describe, expect, it } from 'vitest';

import { createContext } from './trpc.js';

describe('createContext', () => {
  it('extracts bearer token from Authorization header', () => {
    const req = { headers: { authorization: 'Bearer my-token' } } as any;
    const ctx = createContext({ req });
    expect(ctx.token).toBe('my-token');
  });

  it('extracts token from query param', () => {
    const req = { headers: {}, url: '/trpc?token=my-token' } as any;
    const ctx = createContext({ req });
    expect(ctx.token).toBe('my-token');
  });

  it('returns null token when no auth provided', () => {
    const req = { headers: {} } as any;
    const ctx = createContext({ req });
    expect(ctx.token).toBeNull();
  });

  it('prefers Authorization header over query param', () => {
    const req = {
      headers: { authorization: 'Bearer header-token' },
      url: '/trpc?token=query-token',
    } as any;
    const ctx = createContext({ req });
    expect(ctx.token).toBe('header-token');
  });
});
