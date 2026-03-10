import { z } from 'zod';

import type { GameConfig } from '../agent/llm/config.js';
import type { LobbyManager, Lobby } from './lobby-manager.js';
import { publicProcedure, router } from './trpc.js';

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
  return router({
    list: publicProcedure.query(() => {
      return lobbyManager.listLobbies().map(serializeLobby);
    }),

    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input }) => {
        const lobby = lobbyManager.getLobby(input.id);
        if (!lobby) throw new Error(`Lobby ${input.id} not found`);
        return {
          ...serializeLobby(lobby),
          config: lobby.config,
        };
      }),

    create: publicProcedure
      .input(lobbyConfigSchema)
      .mutation(({ input }) => {
        const id = lobbyManager.createLobby(input);
        return { id };
      }),

    start: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        lobbyManager.startLobby(input.id);
        return { ok: true };
      }),

    delete: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        lobbyManager.deleteLobby(input.id);
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
