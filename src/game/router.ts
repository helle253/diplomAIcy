import { readFileSync } from 'fs';
import { join } from 'path';

import { tracked, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4';

import { buildMapState } from '../engine/map-state.js';
import { Coast, OrderType, Phase, Power, UnitType } from '../engine/types.js';
import type { OrderResolution } from '../engine/types.js';
import type { LobbyManager } from './lobby-manager.js';
import type { GameManager, TurnRecord } from './manager.js';
import { createProtectedProcedures, publicProcedure, router } from './trpc.js';

const RULES_TEMPLATE = readFileSync(join(process.cwd(), 'src/engine/RULES.md'), 'utf-8');

// ── Zod schemas ────────────────────────────────────────────────────────

const powerEnum = z.enum([
  Power.England,
  Power.France,
  Power.Germany,
  Power.Italy,
  Power.Austria,
  Power.Russia,
  Power.Turkey,
]);

const coastEnum = z.enum([Coast.North, Coast.South]);

const orderSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(OrderType.Hold), unit: z.string() }),
  z.object({
    type: z.literal(OrderType.Move),
    unit: z.string(),
    destination: z.string(),
    coast: coastEnum.optional(),
    viaConvoy: z.boolean().optional(),
  }),
  z.object({
    type: z.literal(OrderType.Support),
    unit: z.string(),
    supportedUnit: z.string(),
    destination: z.string().optional(),
  }),
  z.object({
    type: z.literal(OrderType.Convoy),
    unit: z.string(),
    convoyedUnit: z.string(),
    destination: z.string(),
  }),
]);

const retreatOrderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('RetreatMove'),
    unit: z.string(),
    destination: z.string(),
    coast: coastEnum.optional(),
  }),
  z.object({ type: z.literal('Disband'), unit: z.string() }),
]);

const buildOrderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('Build'),
    unitType: z.enum([UnitType.Army, UnitType.Fleet]),
    province: z.string(),
    coast: coastEnum.optional(),
  }),
  z.object({ type: z.literal('Remove'), unit: z.string() }),
  z.object({ type: z.literal('Waive') }),
]);

// ── Precomputed JSON schemas ──────────────────────────────────────────

const ORDER_JSON_SCHEMA = toJSONSchema(orderSchema);
const RETREAT_JSON_SCHEMA = toJSONSchema(retreatOrderSchema);
const BUILD_JSON_SCHEMA = toJSONSchema(buildOrderSchema);

// ── Serialization helpers ──────────────────────────────────────────────

interface WireOrderRound {
  phase: Phase;
  orders: OrderResolution[];
}

function serializeOrderHistory(
  turnHistory: TurnRecord[],
): Record<string, WireOrderRound[]> {
  const byPower: Record<string, WireOrderRound[]> = {};
  for (const turn of turnHistory) {
    if (!turn.orders) continue;
    // Group resolutions in this round by power
    const grouped = new Map<string, OrderResolution[]>();
    for (const res of turn.orders) {
      const arr = grouped.get(res.power) ?? [];
      arr.push(res);
      grouped.set(res.power, arr);
    }
    // Append each power's round with phase label
    for (const [power, orders] of grouped) {
      if (!byPower[power]) byPower[power] = [];
      byPower[power].push({ phase: turn.phase, orders });
    }
  }
  return byPower;
}

interface PowerSummary {
  units: number;
  supplyCenters: number;
  buildCount: number;
}

function buildPowerSummary(manager: GameManager): Record<string, PowerSummary> {
  const state = manager.getState();
  const summary: Record<string, PowerSummary> = {};

  // Count units per power
  for (const unit of state.units) {
    if (!summary[unit.power]) summary[unit.power] = { units: 0, supplyCenters: 0, buildCount: 0 };
    summary[unit.power].units++;
  }

  // Count SCs per power
  for (const [, power] of state.supplyCenters) {
    if (!summary[power]) summary[power] = { units: 0, supplyCenters: 0, buildCount: 0 };
    summary[power].supplyCenters++;
  }

  // Compute buildCount (SC - units)
  for (const power of Object.keys(summary)) {
    summary[power].buildCount = summary[power].supplyCenters - summary[power].units;
  }

  return summary;
}

function serializeState(manager: GameManager) {
  const state = manager.getState();
  return {
    phase: state.phase,
    map: buildMapState(state.units, state.supplyCenters),
    powers: buildPowerSummary(manager),
    orderHistory: serializeOrderHistory(manager.getTurnHistory()),
    retreatSituations: state.retreatSituations,
    endYear: state.endYear,
    deadlineMs: manager.getDeadline(),
  };
}

// ── Lobby resolution ──────────────────────────────────────────────────

const lobbyIdInput = z.object({ lobbyId: z.string() });

function resolveManager(lobbyManager: LobbyManager, lobbyId: string): GameManager {
  const lobby = lobbyManager.getLobby(lobbyId);
  if (!lobby || !lobby.manager) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `No active game for lobby ${lobbyId}` });
  }
  return lobby.manager;
}

// ── Router factory ─────────────────────────────────────────────────────

export function createGameRouter(lobbyManager: LobbyManager) {
  const { playerProcedure } = createProtectedProcedures(lobbyManager);

  const gameRouter = router({
    // Queries
    getState: publicProcedure.input(lobbyIdInput).query(({ input }) => {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      const lobby = lobbyManager.getLobby(input.lobbyId)!;
      return { ...serializeState(manager), gameOver: lobby.status === 'finished' };
    }),

    getPhase: publicProcedure.input(lobbyIdInput).query(({ input }) => {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      return manager.getState().phase;
    }),

    getBuildCount: publicProcedure
      .input(lobbyIdInput.extend({ power: powerEnum }))
      .query(({ input }) => {
        const manager = resolveManager(lobbyManager, input.lobbyId);
        return { buildCount: manager.getBuildCount(input.power) };
      }),

    getRules: publicProcedure.input(lobbyIdInput).query(({ input }) => {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      const config = manager.getGameConfig();
      const deadlineStr =
        config.phaseDeadlineMs > 0
          ? `${Math.round(config.phaseDeadlineMs / 1000)} seconds per phase`
          : 'No time limit — phases resolve when all orders are submitted';
      const rules = RULES_TEMPLATE.replace('{{VICTORY_THRESHOLD}}', String(config.victoryThreshold))
        .replace('{{END_YEAR}}', String(config.endYear))
        .replace('{{START_YEAR}}', String(config.startYear))
        .replace('{{DEADLINE}}', deadlineStr);
      return { rules };
    }),

    getSchemas: publicProcedure.query(() => ({
      orders: ORDER_JSON_SCHEMA,
      retreats: RETREAT_JSON_SCHEMA,
      builds: BUILD_JSON_SCHEMA,
    })),

    getActivePowers: publicProcedure.input(lobbyIdInput).query(({ input }) => {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      return manager.getActivePowers();
    }),

    getResult: publicProcedure.input(lobbyIdInput).query(({ input }) => {
      const lobby = lobbyManager.getLobby(input.lobbyId);
      if (!lobby) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Lobby ${input.lobbyId} not found` });
      }
      if (lobby.status !== 'finished' || !lobby.result) {
        return null;
      }
      return {
        winner: lobby.result.winner,
        year: lobby.result.year,
        supplyCenters: Object.fromEntries(lobby.result.supplyCenters),
        eliminatedPowers: lobby.result.eliminatedPowers,
      };
    }),

    getMessages: publicProcedure.input(lobbyIdInput).query(({ input, ctx }) => {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      // Authenticated: see messages addressed to this power (private + global)
      if (ctx.token) {
        const identity = lobbyManager.validateToken(ctx.token);
        if (identity && 'power' in identity) {
          return manager.getMessagesFor(identity.power as Power);
        }
      }
      // Spectator: only global messages
      return manager.getMessages().filter((m) => m.to === 'Global');
    }),

    // Mutations
    submitOrders: playerProcedure
      .input(z.object({ orders: z.array(orderSchema) }))
      .mutation(({ ctx, input }) => {
        const manager = resolveManager(lobbyManager, ctx.lobbyId);
        manager.submitOrders(ctx.power, input.orders);
        return { ok: true };
      }),

    submitRetreats: playerProcedure
      .input(z.object({ retreats: z.array(retreatOrderSchema) }))
      .mutation(({ ctx, input }) => {
        const manager = resolveManager(lobbyManager, ctx.lobbyId);
        manager.submitRetreats(ctx.power, input.retreats);
        return { ok: true };
      }),

    submitBuilds: playerProcedure
      .input(z.object({ builds: z.array(buildOrderSchema) }))
      .mutation(({ ctx, input }) => {
        const manager = resolveManager(lobbyManager, ctx.lobbyId);
        manager.submitBuilds(ctx.power, input.builds);
        return { ok: true };
      }),

    sendMessage: playerProcedure
      .input(
        z.object({
          to: z.union([powerEnum, z.array(powerEnum), z.literal('Global')]),
          content: z.string(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const lobby = lobbyManager.getLobby(ctx.lobbyId);
        if (lobby?.status === 'finished' && !lobby.config.postGamePress) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Post-game press is disabled' });
        }
        const manager = resolveManager(lobbyManager, ctx.lobbyId);
        manager.sendMessage({
          from: ctx.power,
          to: input.to,
          content: input.content,
          phase: manager.getState().phase,
          timestamp: Date.now(),
        });
        return { ok: true };
      }),

    // Subscriptions
    onPhaseChange: publicProcedure.input(lobbyIdInput).subscription(async function* ({
      input,
      signal,
    }) {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      let id = 0;
      const queue: { phase: Phase; gameState: ReturnType<typeof serializeState> }[] = [];
      let resolve: (() => void) | null = null;

      const listener = () => {
        queue.push({ phase: manager.getState().phase, gameState: serializeState(manager) });
        if (resolve) {
          resolve();
          resolve = null;
        }
      };
      manager.onPhaseChange(listener);

      while (!signal?.aborted) {
        if (queue.length > 0) {
          const event = queue.shift()!;
          yield tracked(String(id++), event);
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    }),

    onMessage: publicProcedure.input(lobbyIdInput).subscription(async function* ({
      input,
      signal,
      ctx,
    }) {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      // Resolve power from token if present
      let filterPower: Power | undefined;
      if (ctx.token) {
        const identity = lobbyManager.validateToken(ctx.token);
        if (identity && 'power' in identity) {
          filterPower = identity.power;
        }
      }

      let id = 0;
      type Msg = {
        from: string;
        to: string | string[];
        content: string;
        phase: Phase;
        timestamp: number;
      };
      const queue: Msg[] = [];
      let resolve: (() => void) | null = null;

      manager.onMessage((message) => {
        if (filterPower) {
          // Authenticated: receive messages addressed to this power or broadcast
          const isRecipient =
            message.to === 'Global' ||
            message.to === filterPower ||
            (Array.isArray(message.to) && message.to.includes(filterPower));
          if (!isRecipient) return;
        } else {
          // Spectator: only broadcast messages
          if (message.to !== 'Global') return;
        }
        queue.push(message);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      while (!signal?.aborted) {
        if (queue.length > 0) {
          const msg = queue.shift()!;
          yield tracked(String(id++), msg);
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    }),
  });

  return gameRouter;
}

// Re-export the router type for tRPC client usage
export type GameRouter = ReturnType<typeof createGameRouter>;
