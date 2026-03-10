import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { GameConfig } from '../agent/llm/config.js';
import { Power } from '../engine/types.js';
import type { Lobby, LobbyManager } from './lobby-manager.js';
import { createProtectedProcedures, publicProcedure, router } from './trpc.js';

const powerEnum = z.enum([
  Power.England,
  Power.France,
  Power.Germany,
  Power.Italy,
  Power.Austria,
  Power.Russia,
  Power.Turkey,
]);

const agentConfigSchema = z.object({
  type: z.enum(['random', 'llm', 'remote']),
  provider: z.enum(['openai', 'anthropic']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
});

const lobbyConfigSchema = z.object({
  name: z.string().min(1).max(100),
  maxYears: z.number().int().min(1).max(100).default(10),
  victoryThreshold: z.number().int().min(1).max(34).default(18),
  startYear: z.number().int().min(1).max(9999).default(1901),
  phaseDelayMs: z.number().int().min(0).default(0),
  remoteTimeoutMs: z.number().int().min(0).default(0),
  pressDelayMin: z.number().int().min(0).default(0),
  pressDelayMax: z.number().int().min(0).default(0),
  autostart: z.boolean().default(false),
  agentConfig: z
    .object({
      defaultAgent: agentConfigSchema,
      powers: z.record(z.string(), agentConfigSchema.partial()).optional(),
    })
    .default({ defaultAgent: { type: 'random' } }),
});

function serializeLobby(lobby: Lobby) {
  return {
    id: lobby.id,
    name: lobby.config.name,
    status: lobby.status,
    createdAt: lobby.createdAt,
    maxYears: lobby.config.maxYears,
    victoryThreshold: lobby.config.victoryThreshold,
    startYear: lobby.config.startYear,
    seatCount: lobby.seats.size,
  };
}

export interface LobbyDefaults {
  maxYears: number;
  phaseDelayMs: number;
  remoteTimeoutMs: number;
  pressDelayMin: number;
  pressDelayMax: number;
  agentConfig: GameConfig;
}

export function createLobbyRouter(lobbyManager: LobbyManager, defaults: LobbyDefaults) {
  const { creatorProcedure } = createProtectedProcedures(lobbyManager);

  return router({
    list: publicProcedure.query(() => {
      return lobbyManager.listLobbies().map(serializeLobby);
    }),

    get: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => {
      const lobby = lobbyManager.getLobby(input.id);
      if (!lobby) throw new Error(`Lobby ${input.id} not found`);
      return {
        ...serializeLobby(lobby),
        config: lobby.config,
      };
    }),

    create: publicProcedure.input(lobbyConfigSchema).mutation(({ input }) => {
      return lobbyManager.createLobby(input);
    }),

    join: publicProcedure
      .input(z.object({ lobbyId: z.string(), power: powerEnum }))
      .mutation(({ input }) => {
        try {
          return lobbyManager.joinLobby(input.lobbyId, input.power);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('already claimed')) {
            throw new TRPCError({ code: 'CONFLICT', message: msg });
          }
          if (msg.includes('not accepting')) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: msg });
          }
          throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        }
      }),

    rejoin: publicProcedure
      .input(z.object({ lobbyId: z.string(), power: powerEnum, oldToken: z.string() }))
      .mutation(({ input }) => {
        try {
          return lobbyManager.rejoinLobby(input.lobbyId, input.power, input.oldToken);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('Invalid token')) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: msg });
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: msg });
        }
      }),

    start: creatorProcedure.mutation(async ({ ctx }) => {
      await lobbyManager.startLobby(ctx.lobbyId);
      return { ok: true };
    }),

    delete: creatorProcedure.mutation(({ ctx }) => {
      lobbyManager.deleteLobby(ctx.lobbyId);
      return { ok: true };
    }),

    kick: creatorProcedure.input(z.object({ power: powerEnum })).mutation(({ ctx, input }) => {
      lobbyManager.kickPlayer(ctx.lobbyId, input.power);
      return { ok: true };
    }),

    getDefaults: publicProcedure.query(() => ({
      maxYears: defaults.maxYears,
      victoryThreshold: 18,
      startYear: 1901,
      phaseDelayMs: defaults.phaseDelayMs,
      remoteTimeoutMs: defaults.remoteTimeoutMs,
      pressDelayMin: defaults.pressDelayMin,
      pressDelayMax: defaults.pressDelayMax,
      agentConfig: defaults.agentConfig,
    })),
  });
}

export type LobbyRouter = ReturnType<typeof createLobbyRouter>;
