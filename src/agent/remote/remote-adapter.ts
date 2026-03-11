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
  lobbyId: string,
): Promise<{ unsubscribe: () => void }> {
  // 1. Initialize agent with current game state
  const serializedState = await client.game.getState.query({ lobbyId });
  const initialState = deserializeGameState(serializedState as SerializedGameState);
  await agent.initialize(initialState);
  logger.info(`[${agent.power}] Initialized with remote game state`);

  // ── Serialized work queue ──────────────────────────────────────────
  // All async work goes through this queue to prevent concurrent API calls.
  // Phase items take priority over message items.
  const MESSAGE_BATCH_DELAY = parseInt(process.env.MESSAGE_BATCH_DELAY ?? '5000', 10);

  type WorkItem =
    | { kind: 'phase'; gameState: ReturnType<typeof deserializeGameState>; deadlineMs: number }
    | { kind: 'messageBatch'; messages: Message[] };

  const workQueue: WorkItem[] = [];
  let working = false;

  // ── Message batching ────────────────────────────────────────────────
  let pendingMessages: Message[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  const deferCounts = new Map<string, number>(); // tracks how many times a message was deferred

  function flushPendingMessages() {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (pendingMessages.length > 0) {
      const batch = pendingMessages;
      pendingMessages = [];
      logger.info(`[${agent.power}] Flushing ${batch.length} batched messages`);
      workQueue.push({ kind: 'messageBatch', messages: batch });
    }
  }

  function enqueuePhase(gameState: ReturnType<typeof deserializeGameState>, deadlineMs: number) {
    // Flush any pending messages before clearing — they belong to the current phase
    flushPendingMessages();

    // Clear any queued message batches — they're stale once a new phase arrives
    const staleCount = workQueue.filter((w) => w.kind === 'messageBatch').length;
    if (staleCount > 0) {
      logger.info(`[${agent.power}] Clearing ${staleCount} stale message batches from queue`);
    }
    // Remove all pending message batches, keep only phase items
    const kept = workQueue.filter((w) => w.kind === 'phase');
    workQueue.length = 0;
    workQueue.push(...kept);
    workQueue.push({ kind: 'phase', gameState, deadlineMs });
    deferCounts.clear();
    drainWorkQueue();
  }

  function enqueueMessage(message: Message) {
    pendingMessages.push(message);
    // Reset the debounce timer
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushPendingMessages();
      drainWorkQueue();
    }, MESSAGE_BATCH_DELAY);
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
            await handleMessageBatch(item.messages);
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

  // Random per-agent stagger so agents don't all fire opening messages simultaneously.
  // This creates natural turn-taking: early agents' messages arrive before later agents compose theirs.
  const PHASE_STAGGER_MAX = parseInt(process.env.PHASE_STAGGER ?? '15000', 10);
  const agentStagger = Math.floor(Math.random() * PHASE_STAGGER_MAX);
  logger.info(`[${agent.power}] Phase stagger: ${(agentStagger / 1000).toFixed(1)}s`);

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
        await client.game.submitOrders.mutate({ orders });
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
          await client.game.submitRetreats.mutate({ retreats });
          logger.info(`[${agent.power}] retreats submitted to server`);
        }
      } else if (gameState.phase.type === PhaseType.Builds) {
        const { buildCount } = await client.game.getBuildCount.query({
          lobbyId,
          power: agent.power,
        });
        if (buildCount !== 0) {
          logger.info(`[${agent.power}] submitBuilds (buildCount=${buildCount})`);
          const builds = await agent.submitBuilds(gameState, buildCount);
          for (const b of builds) {
            logger.info(`[${agent.power}]   build: ${JSON.stringify(b)}`);
          }
          await client.game.submitBuilds.mutate({ builds });
          logger.info(`[${agent.power}] builds submitted to server`);
        }
      }
    } catch (err) {
      logger.error(`[${agent.power}] phase action error:`, err);
    }

    // Stagger before sending press so agents naturally take turns in diplomacy.
    // Without this, all agents compose opening messages simultaneously and
    // "talk past" each other since none see each other's messages.
    if (agentStagger > 0) {
      logger.info(`[${agent.power}] Staggering diplomacy by ${(agentStagger / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, agentStagger));
    }

    // Send press AFTER orders are submitted (and stagger)
    try {
      const messages = await agent.onPhaseStart(gameState);
      for (const msg of messages) {
        logger.info(`[${agent.power}] -> ${formatTo(msg.to)}: ${msg.content}`);
        await client.game.sendMessage.mutate({
          to: msg.to,
          content: msg.content,
        });
      }
    } catch (err) {
      logger.error(`[${agent.power}] onPhaseStart error:`, err);
    }
  }

  // ── Message batch handler ─────────────────────────────────────────

  const MAX_DEFERS = 2; // max times a message can be deferred before being dropped

  async function handleMessageBatch(messages: Message[]) {
    try {
      const state = await client.game.getState.query({ lobbyId });
      const gameState = deserializeGameState(state as SerializedGameState);

      let replies: Message[];
      let deferred: Message[] = [];

      if (agent.onMessages) {
        const result = await agent.onMessages(messages, gameState);
        replies = result.replies;
        deferred = result.deferred;
      } else {
        // Fallback: call onMessage sequentially for each message
        replies = [];
        for (const msg of messages) {
          const r = await agent.onMessage(msg, gameState);
          replies.push(...r);
        }
      }

      for (const reply of replies) {
        logger.info(`[${agent.power}] -> ${formatTo(reply.to)}: ${reply.content}`);
        await client.game.sendMessage.mutate({
          to: reply.to,
          content: reply.content,
        });
      }

      // Re-queue deferred messages (with defer count tracking)
      if (deferred.length > 0) {
        const requeued: Message[] = [];
        for (const msg of deferred) {
          const key = msg.id ?? `${msg.from}-${msg.timestamp}`;
          const count = (deferCounts.get(key) ?? 0) + 1;
          if (count > MAX_DEFERS) {
            logger.info(
              `[${agent.power}] Dropping deferred message from ${msg.from} (max defers reached)`,
            );
            continue;
          }
          deferCounts.set(key, count);
          requeued.push(msg);
        }
        if (requeued.length > 0) {
          logger.info(`[${agent.power}] Re-queuing ${requeued.length} deferred messages`);
          pendingMessages.push(...requeued);
          // Restart the batch timer for the deferred messages
          if (!batchTimer) {
            batchTimer = setTimeout(() => {
              batchTimer = null;
              flushPendingMessages();
              drainWorkQueue();
            }, MESSAGE_BATCH_DELAY);
          }
        }
      }
    } catch (err) {
      logger.error(`[${agent.power}] onMessageBatch error:`, err);
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
  const phaseSub = client.game.onPhaseChange.subscribe(
    { lobbyId },
    {
      onData(envelope) {
        const tracked = envelope as unknown as {
          id: string;
          data: { gameState: SerializedGameState; deadlineMs?: number };
        };
        if (!tracked?.data?.gameState) {
          logger.warn(`[${agent.power}] Unexpected phase envelope shape, skipping`);
          return;
        }
        const gameState = deserializeGameState(tracked.data.gameState);
        const key = phaseKey(gameState);
        if (key === lastHandledPhase) return;
        lastHandledPhase = key;
        enqueuePhase(gameState, tracked.data.gameState.deadlineMs ?? 0);
      },
      onError(err) {
        logger.error(`[${agent.power}] onPhaseChange subscription error:`, err);
      },
    },
  );
  subs.push(phaseSub);

  // Subscribe to messages
  const msgSub = client.game.onMessage.subscribe(
    { lobbyId },
    {
      onData(envelope) {
        const tracked = envelope as unknown as { id: string; data: Message };
        if (!tracked?.data?.from) {
          logger.warn(`[${agent.power}] Unexpected message envelope shape, skipping`);
          return;
        }
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
    const currentState = await client.game.getState.query({ lobbyId });
    const currentGameState = deserializeGameState(currentState as SerializedGameState);
    const key = phaseKey(currentGameState);
    if (
      key !== lastHandledPhase &&
      (currentGameState.phase.type === PhaseType.Diplomacy ||
        currentGameState.phase.type === PhaseType.Orders ||
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
