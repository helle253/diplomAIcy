import type { Unsubscribable } from '@trpc/server/observable';

import type { Message } from '../../engine/types.js';
import { PhaseType } from '../../engine/types.js';
import { logger } from '../../util/logger.js';
import type { DiplomacyAgent } from '../interface.js';
import type { GameClient } from './client.js';
import { deserializeGameState, type SerializedGameState } from './deserialize.js';

function formatTo(to: Message['to']): string {
  return Array.isArray(to) ? to.join(', ') : to;
}

/**
 * Connects a DiplomacyAgent to a remote game server via tRPC.
 * All work (phase handling and message processing) is serialized through a single
 * work queue to prevent concurrent HTTP/LLM calls that cause connection exhaustion
 * and rate limiting.
 */
export async function connectRemoteAgent(
  agent: DiplomacyAgent,
  client: GameClient,
): Promise<{ unsubscribe: () => void }> {
  // 1. Initialize agent with current game state
  const serializedState = await client.getState.query();
  const initialState = deserializeGameState(serializedState as SerializedGameState);
  await agent.initialize(initialState);
  logger.info(`[${agent.power}] Initialized with remote game state`);

  // ── Serialized work queue ──────────────────────────────────────────
  // All async work goes through this queue to prevent concurrent API calls.
  // Phase items take priority over message items.
  type WorkItem =
    | { kind: 'phase'; gameState: ReturnType<typeof deserializeGameState>; deadlineMs: number }
    | { kind: 'message'; message: Message };

  const workQueue: WorkItem[] = [];
  let working = false;

  function enqueuePhase(gameState: ReturnType<typeof deserializeGameState>, deadlineMs: number) {
    // Clear any pending messages — they're stale once a new phase arrives
    const staleCount = workQueue.filter((w) => w.kind === 'message').length;
    if (staleCount > 0) {
      logger.info(`[${agent.power}] Clearing ${staleCount} stale messages from queue`);
    }
    // Remove all pending messages, keep only phase items (shouldn't be any but just in case)
    const kept = workQueue.filter((w) => w.kind === 'phase');
    workQueue.length = 0;
    workQueue.push(...kept);
    workQueue.push({ kind: 'phase', gameState, deadlineMs });
    drainWorkQueue();
  }

  function enqueueMessage(message: Message) {
    workQueue.push({ kind: 'message', message });
    drainWorkQueue();
  }

  async function drainWorkQueue() {
    if (working) return;
    working = true;
    try {
      while (workQueue.length > 0) {
        // Prioritize phase items — pull the first phase item if any, otherwise first item
        const phaseIdx = workQueue.findIndex((w) => w.kind === 'phase');
        const idx = phaseIdx >= 0 ? phaseIdx : 0;
        const item = workQueue.splice(idx, 1)[0];

        try {
          if (item.kind === 'phase') {
            await handlePhase(item.gameState, item.deadlineMs);
          } else {
            await handleMessage(item.message);
          }
        } catch (err) {
          logger.error(`[${agent.power}] work queue error:`, err);
        }
      }
    } finally {
      working = false;
    }
  }

  // ── Phase handler ──────────────────────────────────────────────────

  async function handlePhase(
    gameState: ReturnType<typeof deserializeGameState>,
    deadlineMs: number,
  ) {
    if (deadlineMs > 0) {
      const remaining = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
      logger.info(`[${agent.power}] Phase ${gameState.phase.type} -- deadline in ${remaining}s`);
    }

    // Submit phase-appropriate actions FIRST (orders > messages)
    try {
      if (gameState.phase.type === PhaseType.Orders) {
        logger.info(`[${agent.power}] submitOrders`);
        const orders = await agent.submitOrders(gameState);
        for (const o of orders) {
          logger.info(`[${agent.power}]   order: ${JSON.stringify(o)}`);
        }
        await client.submitOrders.mutate({ power: agent.power, orders });
        logger.info(`[${agent.power}] orders submitted to server`);
      } else if (gameState.phase.type === PhaseType.Retreats) {
        // Only submit if this power has dislodged units
        const myRetreats = gameState.retreatSituations.filter((s) => s.unit.power === agent.power);
        if (myRetreats.length > 0) {
          logger.info(`[${agent.power}] submitRetreats (${myRetreats.length} dislodged)`);
          const retreats = await agent.submitRetreats(gameState, gameState.retreatSituations);
          for (const r of retreats) {
            logger.info(`[${agent.power}]   retreat: ${JSON.stringify(r)}`);
          }
          await client.submitRetreats.mutate({ power: agent.power, retreats });
          logger.info(`[${agent.power}] retreats submitted to server`);
        }
      } else if (gameState.phase.type === PhaseType.Builds) {
        const { buildCount } = await client.getBuildCount.query({ power: agent.power });
        if (buildCount !== 0) {
          logger.info(`[${agent.power}] submitBuilds (buildCount=${buildCount})`);
          const builds = await agent.submitBuilds(gameState, buildCount);
          for (const b of builds) {
            logger.info(`[${agent.power}]   build: ${JSON.stringify(b)}`);
          }
          await client.submitBuilds.mutate({ power: agent.power, builds });
          logger.info(`[${agent.power}] builds submitted to server`);
        }
      }
    } catch (err) {
      logger.error(`[${agent.power}] phase action error:`, err);
    }

    // Send press AFTER orders are submitted
    try {
      const messages = await agent.onPhaseStart(gameState);
      for (const msg of messages) {
        logger.info(`[${agent.power}] -> ${formatTo(msg.to)}: ${msg.content}`);
        await client.sendMessage.mutate({
          from: msg.from,
          to: msg.to,
          content: msg.content,
        });
      }
    } catch (err) {
      logger.error(`[${agent.power}] onPhaseStart error:`, err);
    }
  }

  // ── Message handler ────────────────────────────────────────────────

  async function handleMessage(message: Message) {
    try {
      const state = await client.getState.query();
      const gameState = deserializeGameState(state as SerializedGameState);
      const replies = await agent.onMessage(message, gameState);
      for (const reply of replies) {
        logger.info(`[${agent.power}] -> ${formatTo(reply.to)}: ${reply.content}`);
        await client.sendMessage.mutate({
          from: reply.from,
          to: reply.to,
          content: reply.content,
        });
      }
    } catch (err) {
      logger.error(`[${agent.power}] onMessage error:`, err);
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  const subs: Unsubscribable[] = [];
  let lastHandledPhase = '';

  function phaseKey(gs: ReturnType<typeof deserializeGameState>): string {
    const p = gs.phase;
    return `${p.year}-${p.season}-${p.type}`;
  }

  // Subscribe to phase changes
  const phaseSub = client.onPhaseChange.subscribe(undefined, {
    onData(envelope) {
      const tracked = envelope as unknown as {
        id: string;
        data: { gameState: SerializedGameState };
      };
      const gameState = deserializeGameState(tracked.data.gameState);
      const key = phaseKey(gameState);
      if (key === lastHandledPhase) return;
      lastHandledPhase = key;
      enqueuePhase(gameState, tracked.data.gameState.deadlineMs);
    },
    onError(err) {
      logger.error(`[${agent.power}] onPhaseChange subscription error:`, err);
    },
  });
  subs.push(phaseSub);

  // Subscribe to messages
  const msgSub = client.onMessage.subscribe(
    { power: agent.power },
    {
      onData(envelope) {
        const tracked = envelope as unknown as { id: string; data: Message };
        const message = tracked.data;
        if (message.from === agent.power) return;
        logger.info(`[${agent.power}] <- ${message.from}: ${message.content}`);
        enqueueMessage(message);
      },
      onError(err) {
        logger.error(`[${agent.power}] onMessage subscription error:`, err);
      },
    },
  );
  subs.push(msgSub);

  const unsubscribe = () => {
    for (const sub of subs) sub.unsubscribe();
    logger.info(`[${agent.power}] Disconnected from server`);
  };

  process.on('SIGINT', () => {
    unsubscribe();
    process.exit(0);
  });

  logger.info(`[${agent.power}] Connected to remote server, listening for phase changes`);

  // Catch up: act on the current phase if we missed the SSE event
  try {
    const currentState = await client.getState.query();
    const currentGameState = deserializeGameState(currentState as SerializedGameState);
    const key = phaseKey(currentGameState);
    if (
      key !== lastHandledPhase &&
      (currentGameState.phase.type === PhaseType.Orders ||
        currentGameState.phase.type === PhaseType.Retreats ||
        currentGameState.phase.type === PhaseType.Builds)
    ) {
      lastHandledPhase = key;
      logger.info(`[${agent.power}] Catching up on current phase: ${currentGameState.phase.type}`);
      enqueuePhase(currentGameState, (currentState as SerializedGameState).deadlineMs);
    }
  } catch (err) {
    logger.error(`[${agent.power}] catch-up error (non-fatal):`, err);
  }

  return { unsubscribe };
}
