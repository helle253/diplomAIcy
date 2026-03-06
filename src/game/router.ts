import { tracked } from '@trpc/server';
import { z } from 'zod';

import { Coast, OrderType, Phase, Power, UnitType } from '../engine/types.js';
import type { GameManager } from './manager.js';
import { publicProcedure, router } from './trpc.js';

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

const messageInputSchema = z.object({
  from: powerEnum,
  to: z.union([powerEnum, z.array(powerEnum), z.literal('Global')]),
  content: z.string(),
});

// ── Serialization helpers ──────────────────────────────────────────────

function serializeState(manager: GameManager) {
  const state = manager.getState();
  return {
    phase: state.phase,
    units: state.units,
    supplyCenters: Object.fromEntries(state.supplyCenters),
    orderHistory: state.orderHistory,
    retreatSituations: state.retreatSituations,
    deadlineMs: manager.getDeadline(),
  };
}

// ── Router factory ─────────────────────────────────────────────────────

export function createGameRouter(manager: GameManager) {
  const gameRouter = router({
    // Queries
    getState: publicProcedure.query(() => serializeState(manager)),

    getPhase: publicProcedure.query(() => manager.getState().phase),

    getBuildCount: publicProcedure
      .input(z.object({ power: powerEnum }))
      .query(({ input }) => ({ buildCount: manager.getBuildCount(input.power) })),

    getActivePowers: publicProcedure.query(() => manager.getActivePowers()),

    // Mutations
    submitOrders: publicProcedure
      .input(z.object({ power: powerEnum, orders: z.array(orderSchema) }))
      .mutation(({ input }) => {
        manager.submitOrders(input.power, input.orders);
        return { ok: true };
      }),

    submitRetreats: publicProcedure
      .input(z.object({ power: powerEnum, retreats: z.array(retreatOrderSchema) }))
      .mutation(({ input }) => {
        manager.submitRetreats(input.power, input.retreats);
        return { ok: true };
      }),

    submitBuilds: publicProcedure
      .input(z.object({ power: powerEnum, builds: z.array(buildOrderSchema) }))
      .mutation(({ input }) => {
        manager.submitBuilds(input.power, input.builds);
        return { ok: true };
      }),

    sendMessage: publicProcedure.input(messageInputSchema).mutation(({ input }) => {
      manager.sendMessage({
        from: input.from,
        to: input.to,
        content: input.content,
        phase: manager.getState().phase,
        timestamp: Date.now(),
      });
      return { ok: true };
    }),

    // Subscriptions
    onPhaseChange: publicProcedure.subscription(async function* ({ signal }) {
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

    onMessage: publicProcedure
      .input(z.object({ power: powerEnum }).optional())
      .subscription(async function* ({ input, signal }) {
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
          // If power specified, filter messages addressed to them
          if (input?.power) {
            const isRecipient =
              message.to === 'Global' ||
              message.to === input.power ||
              (Array.isArray(message.to) && message.to.includes(input.power));
            if (!isRecipient) return;
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
