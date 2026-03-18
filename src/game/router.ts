import { tracked, TRPCError } from '@trpc/server';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4';

import { buildMapState } from '../engine/map-state';
import type { OrderResolution } from '../engine/types';
import { Coast, OrderType, Phase, Power, UnitType } from '../engine/types';
import type { LobbyManager } from './lobby-manager';
import type { GameManager, TurnRecord } from './manager';
import { createProtectedProcedures, publicProcedure, router } from './trpc';

const RULES_TEMPLATE = readFileSync(new URL('../engine/RULES.md', import.meta.url), 'utf-8');

// ── Zod schemas ────────────────────────────────────────────────────────

const POWER_ABBREV: Record<string, Power> = {
  eng: Power.England,
  fra: Power.France,
  ger: Power.Germany,
  ita: Power.Italy,
  aus: Power.Austria,
  rus: Power.Russia,
  tur: Power.Turkey,
};

const powerEnum = z
  .enum([
    Power.England,
    Power.France,
    Power.Germany,
    Power.Italy,
    Power.Austria,
    Power.Russia,
    Power.Turkey,
    // Accept abbreviations too
    'eng',
    'fra',
    'ger',
    'ita',
    'aus',
    'rus',
    'tur',
  ])
  .transform((val) => POWER_ABBREV[val] ?? val) as unknown as z.ZodType<Power>;

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

// ── Precomputed JSON schemas (match submission body shapes) ──────────

const ORDER_JSON_SCHEMA = toJSONSchema(z.object({ orders: z.array(orderSchema) }));
const RETREAT_JSON_SCHEMA = toJSONSchema(z.object({ retreats: z.array(retreatOrderSchema) }));
const BUILD_JSON_SCHEMA = toJSONSchema(z.object({ builds: z.array(buildOrderSchema) }));

// ── Serialization helpers ──────────────────────────────────────────────

interface WireOrderRound {
  phase: Phase;
  orders: OrderResolution[];
}

function serializeOrderHistory(turnHistory: TurnRecord[]): Record<string, WireOrderRound[]> {
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

  // Initialize all powers (including eliminated ones)
  for (const power of Object.values(Power)) {
    summary[power] = { units: 0, supplyCenters: 0, buildCount: 0 };
  }

  // Count units per power
  for (const unit of state.units) {
    summary[unit.power].units++;
  }

  // Count SCs per power
  for (const [, power] of state.supplyCenters) {
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
    drawVotes: manager.getDrawVotes(),
    concededPowers: manager.getConcededPowers(),
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
      const fastAdjStr = config.fastAdjudication
        ? 'Enabled — the diplomacy phase ends as soon as all powers signal ready (via submitReady). Send your messages promptly; once all powers are ready, negotiations close immediately'
        : 'Disabled — the diplomacy phase always runs for the full duration regardless of readiness';
      const yearLimitNote = config.endYear ? ` by **${config.endYear}** (the final year)` : '';
      const drawRules = config.allowDraws
        ? `If no power reaches the victory threshold${yearLimitNote}, the game ends in a draw among all surviving powers. Any power may propose a draw during a diplomacy phase. If all surviving powers propose a draw in the same phase, the game ends immediately as a shared draw.`
        : config.endYear
          ? `Draws are disabled. The game continues until a power reaches the victory threshold or the final year (**${config.endYear}**) is reached.`
          : `Draws are disabled. The game continues until a power reaches the victory threshold.`;
      const rules = RULES_TEMPLATE.replace('{{VICTORY_THRESHOLD}}', String(config.victoryThreshold))
        .replace('{{START_YEAR}}', String(config.startYear))
        .replace('{{DRAW_RULES}}', drawRules)
        .replace('{{DEADLINE}}', deadlineStr)
        .replace('{{FAST_ADJUDICATION}}', fastAdjStr);
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

    getMessages: publicProcedure.input(lobbyIdInput).query(({ input, ctx }) => {
      const manager = resolveManager(lobbyManager, input.lobbyId);
      // Authenticated: see messages addressed to this power (private + global)
      if (ctx.token) {
        const identity = lobbyManager.validateToken(ctx.token);
        if (identity && 'power' in identity && identity.lobbyId === input.lobbyId) {
          return manager.getMessagesFor(identity.power as Power);
        }
      }
      // Spectator: see all messages (private + global)
      return manager.getMessages();
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
        concededPowers: lobby.result.concededPowers,
      };
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

    proposeDraw: playerProcedure.mutation(({ ctx }) => {
      const manager = resolveManager(lobbyManager, ctx.lobbyId);
      const accepted = manager.proposeDraw(ctx.power);
      return { accepted };
    }),

    concede: playerProcedure.mutation(({ ctx }) => {
      const manager = resolveManager(lobbyManager, ctx.lobbyId);
      const accepted = manager.concede(ctx.power);
      return { accepted };
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

    submitReady: playerProcedure.mutation(({ ctx }) => {
      const manager = resolveManager(lobbyManager, ctx.lobbyId);
      manager.submitReady(ctx.power);
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
