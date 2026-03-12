import { initTRPC, TRPCError } from '@trpc/server';
import { parse as parseUrl } from 'url';

import type { Power } from '../engine/types';
import type { LobbyManager } from './lobby-manager';

export interface TRPCContext {
  token: string | null;
}

export function createContext({
  req,
}: {
  req: { headers: Record<string, string | string[] | undefined>; url?: string };
}): TRPCContext {
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return { token: authHeader.slice(7) };
  }

  // Fall back to ?token= query param (for SSE/WebSocket)
  if (req.url) {
    const parsed = parseUrl(req.url, true);
    const queryToken = parsed.query.token;
    if (typeof queryToken === 'string') {
      return { token: queryToken };
    }
  }

  return { token: null };
}

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export type PlayerContext = TRPCContext & { power: Power; lobbyId: string };
export type CreatorContext = TRPCContext & { lobbyId: string };

export function createProtectedProcedures(lobbyManager: LobbyManager) {
  const playerProcedure = t.procedure.use(async ({ ctx, next }) => {
    if (!ctx.token) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    const identity = lobbyManager.validateToken(ctx.token);
    if (!identity || !('power' in identity)) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid token' });
    }
    return next({ ctx: { ...ctx, power: identity.power, lobbyId: identity.lobbyId } });
  });

  const creatorProcedure = t.procedure.use(async ({ ctx, next }) => {
    if (!ctx.token) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    const identity = lobbyManager.validateToken(ctx.token);
    if (!identity || !('role' in identity)) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid token' });
    }
    return next({ ctx: { ...ctx, lobbyId: identity.lobbyId } });
  });

  return { playerProcedure, creatorProcedure };
}
