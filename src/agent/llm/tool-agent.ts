import type { Unsubscribable } from '@trpc/server/observable';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import type { GameState } from '../../engine/types';
import { Message, PhaseType, Power } from '../../engine/types';
import { logger } from '../../util/logger';
import type { GameClient } from '../remote/client';
import { deserializeGameState, type SerializedGameState } from '../remote/deserialize';
import type { LLMClient, ToolDefinition } from './llm-client';
import { buildToolSystemPrompt, buildTurnPrompt, extractPlanBlock } from './prompts';
import { parseTextBuilds, parseTextOrders } from './text-parser';
import { GameToolExecutor, TOOL_DEFINITIONS, type ToolGameClient } from './tools';

/** Local query tools that run in-process (not server actions). */
const LOCAL_QUERY_TOOLS: Record<string, string[]> = {
  Orders: [
    'getMyUnits',
    'getAdjacentProvinces',
    'getProvinceInfo',
    'getSupplyCenterCounts',
    'getPhaseInfo',
  ],
  Retreats: ['getMyUnits', 'getRetreatOptions', 'getPhaseInfo'],
  Builds: ['getMyUnits', 'getPhaseInfo'],
};

/** Fallback action sets when server doesn't provide availableActions. */
const FALLBACK_ACTIONS: Record<string, string[]> = {
  Orders: ['submitOrders', 'testOrders', 'sendMessage'],
  Retreats: ['submitRetreats', 'testOrders', 'sendMessage'],
  Builds: ['submitBuilds', 'sendMessage'],
};

/**
 * Build the tool list from server-provided actions + local query tools.
 * Server defines what actions are available; agent adds its own query tools.
 * Falls back to hardcoded defaults if server doesn't provide actions.
 */
function filterTools(phaseType: string, serverActions: string[]): ToolDefinition[] {
  const actions = serverActions.length > 0 ? serverActions : (FALLBACK_ACTIONS[phaseType] ?? []);
  const localTools = LOCAL_QUERY_TOOLS[phaseType] ?? Object.values(LOCAL_QUERY_TOOLS).flat();
  const allowed = new Set([...localTools, ...actions]);
  return TOOL_DEFINITIONS.filter((t) => allowed.has(t.function.name));
}

/**
 * Connects an LLM tool-calling agent to a remote game server via tRPC.
 * Instead of using a DiplomacyAgent interface, the tool loop IS the agent —
 * it queries the map, sends messages, and submits orders via tools.
 */
export async function connectToolAgent(
  client: GameClient,
  llm: LLMClient,
  power: Power,
  lobbyId: string,
  planDir?: string,
): Promise<{ unsubscribe: () => void }> {
  // 1. Fetch initial state
  const serializedState = await client.game.getState.query({ lobbyId });
  const initialState = deserializeGameState(serializedState as SerializedGameState);

  // 2. Build system prompt (once at init)
  const systemPrompt = buildToolSystemPrompt(power, initialState.endYear);

  // ── Plan persistence ─────────────────────────────────────────────
  const planFilePath = planDir ? join(planDir, lobbyId, `${power}-plan.md`) : null;

  async function readPlan(): Promise<string | undefined> {
    if (!planFilePath) return undefined;
    try {
      return await readFile(planFilePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  async function savePlan(plan: string): Promise<void> {
    if (!planFilePath) return;
    await mkdir(dirname(planFilePath), { recursive: true });
    await writeFile(planFilePath, plan);
  }

  // ── Serialized work queue + message accumulator ──────────────────
  const MESSAGE_BATCH_DELAY = parseInt(process.env.MESSAGE_BATCH_DELAY ?? '5000', 10);

  type WorkItem =
    | { kind: 'phase'; gameState: GameState; deadlineMs: number; availableActions?: string[] }
    | { kind: 'messageBatch'; messages: Message[] };

  const workQueue: WorkItem[] = [];
  let working = false;

  // Messages accumulate here permanently. Both message-triggered tool loops
  // AND phase tool loops see all messages received so far. This ensures
  // diplomacy context (pacts, threats, betrayals) is never lost.
  // Capped to prevent context window overflow in long games.
  const MAX_ACCUMULATED_MESSAGES = 50;
  let accumulatedMessages: Message[] = [];
  let pendingMessages: Message[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPendingMessages() {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (pendingMessages.length > 0) {
      const batch = pendingMessages;
      pendingMessages = [];
      // Add to accumulated messages (persistent across phases, capped)
      accumulatedMessages.push(...batch);
      if (accumulatedMessages.length > MAX_ACCUMULATED_MESSAGES) {
        accumulatedMessages = accumulatedMessages.slice(-MAX_ACCUMULATED_MESSAGES);
      }
      logger.info(
        `[${power}] Flushing ${batch.length} batched messages (${accumulatedMessages.length} total)`,
      );
      workQueue.push({ kind: 'messageBatch', messages: batch });
    }
  }

  function enqueuePhase(gameState: GameState, deadlineMs: number, availableActions?: string[]) {
    flushPendingMessages();

    // Clear queued message batches — phase handler will have full accumulated context
    const staleCount = workQueue.filter((w) => w.kind === 'messageBatch').length;
    if (staleCount > 0) {
      logger.info(`[${power}] Clearing ${staleCount} stale message batches from queue`);
    }
    workQueue.length = 0;
    workQueue.push({ kind: 'phase', gameState, deadlineMs, availableActions });
    drainWorkQueue();
  }

  function enqueueMessage(message: Message) {
    pendingMessages.push(message);
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
        const phaseIdx = workQueue.findIndex((w) => w.kind === 'phase');
        const idx = phaseIdx >= 0 ? phaseIdx : 0;
        const item = workQueue.splice(idx, 1)[0];

        try {
          if (item.kind === 'phase') {
            await handlePhase(item.gameState, item.deadlineMs, item.availableActions);
          } else {
            await handleMessageBatch(item.messages);
          }
        } catch (err) {
          logger.error(`[${power}] work queue error:`, err);
        }
      }
    } finally {
      working = false;
    }
  }

  // ── Phase handler ──────────────────────────────────────────────────

  async function handlePhase(
    gameState: GameState,
    deadlineMs: number,
    availableActions?: string[],
  ) {
    if (deadlineMs > 0) {
      const remaining = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
      logger.info(`[${power}] Phase ${gameState.phase.type} -- deadline in ${remaining}s`);
    }

    if (!llm.runToolLoop) {
      logger.error(`[${power}] LLM client does not support tool calling`);
      return;
    }

    const executor = new GameToolExecutor(client as unknown as ToolGameClient, gameState, power);
    const serverActions = availableActions ?? [];
    const tools = filterTools(gameState.phase.type, serverActions);

    // Include ALL accumulated messages — never cleared, so the agent retains
    // full diplomatic history. Messages carry phase stamps for temporal context.
    if (accumulatedMessages.length > 0) {
      logger.info(
        `[${power}] Including ${accumulatedMessages.length} accumulated messages in phase prompt`,
      );
    }
    const currentPlan = await readPlan();
    const userMessage = buildTurnPrompt(gameState, power, accumulatedMessages, currentPlan);

    logger.info(`[${power}] Starting tool loop for phase ${gameState.phase.type}`);
    let response = '';
    try {
      response = await llm.runToolLoop(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        tools,
        executor,
      );
      logger.info(`[${power}] Tool loop complete for phase ${gameState.phase.type}`);

      // Extract and persist plan block from primary response (if any text was produced)
      if (response) {
        const { plan } = extractPlanBlock(response);
        if (plan) {
          await savePlan(plan);
          logger.info(`[${power}] Plan saved for next phase`);
        }
      }
      // Note: when tool calls succeed, response is typically empty — previous plan is kept
    } catch (err) {
      logger.error(`[${power}] Tool loop error:`, err);
    }

    // If model ended without submitting during an actionable phase, retry once
    const needsSubmit =
      gameState.phase.type === PhaseType.Orders ||
      gameState.phase.type === PhaseType.Retreats ||
      gameState.phase.type === PhaseType.Builds;
    let retryResponse = '';
    if (needsSubmit && !executor.hasSubmitted) {
      logger.warn(`[${power}] Model did not submit — retrying with explicit prompt`);
      try {
        retryResponse = await llm.runToolLoop(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
            {
              role: 'user',
              content:
                'You MUST call the submit tool NOW. Call submitOrders/submitRetreats/submitBuilds with your decisions. Do not respond with text — use the tool.',
            },
          ],
          tools,
          executor,
        );
        logger.info(`[${power}] Retry tool loop complete`);
      } catch (err) {
        logger.error(`[${power}] Retry tool loop error:`, err);
      }
    }

    // If still no submission, try parsing from the text responses
    if (needsSubmit && !executor.hasSubmitted) {
      const combinedText = [response, retryResponse].filter(Boolean).join('\n');
      if (combinedText.length > 0) {
        if (gameState.phase.type === PhaseType.Orders) {
          const parsed = parseTextOrders(combinedText, gameState, power);
          if (parsed && parsed.orders.length > 0) {
            const validOrders = parsed.orders.filter((o) =>
              gameState.units.some((u) => u.province === o.unit && u.power === power),
            );
            if (validOrders.length > 0) {
              const coveredUnits = new Set(validOrders.map((o) => o.unit));
              const myUnits = gameState.units.filter((u) => u.power === power);
              const allOrders = [
                ...validOrders,
                ...myUnits
                  .filter((u) => !coveredUnits.has(u.province))
                  .map((u) => ({ unit: u.province, type: 'Hold' as const })),
              ];
              logger.warn(
                `[${power}] Parsed ${validOrders.length} orders from text (${parsed.unmatched.length} unmatched)`,
              );
              try {
                await (client.game.submitOrders.mutate as (input: unknown) => Promise<unknown>)({
                  orders: allOrders,
                });
                executor.hasSubmitted = true;
              } catch (err) {
                logger.error(`[${power}] Text-parsed order submission error:`, err);
              }
            }
          }
        } else if (gameState.phase.type === PhaseType.Builds) {
          const parsed = parseTextBuilds(combinedText);
          if (parsed && parsed.builds.length > 0) {
            logger.warn(
              `[${power}] Parsed ${parsed.builds.length} builds from text (${parsed.unmatched.length} unmatched)`,
            );
            try {
              await (client.game.submitBuilds.mutate as (input: unknown) => Promise<unknown>)({
                builds: parsed.builds,
              });
              executor.hasSubmitted = true;
            } catch (err) {
              logger.error(`[${power}] Text-parsed build submission error:`, err);
            }
          }
        }
      }
    }

    // If still no submission after retry and text parsing, auto-submit defaults
    if (needsSubmit && !executor.hasSubmitted) {
      logger.warn(`[${power}] Auto-submitting defaults — model failed to submit after retry`);
      try {
        if (gameState.phase.type === PhaseType.Orders) {
          const orders = gameState.units
            .filter((u) => u.power === power)
            .map((u) => ({ type: 'Hold', unit: u.province }));
          await (client.game.submitOrders.mutate as (input: unknown) => Promise<unknown>)({
            orders,
          });
        } else if (gameState.phase.type === PhaseType.Retreats) {
          const retreats = gameState.retreatSituations
            .filter((s) => s.unit.power === power)
            .map((s) => ({ type: 'Disband', unit: s.unit.province }));
          await (client.game.submitRetreats.mutate as (input: unknown) => Promise<unknown>)({
            retreats,
          });
        } else if (gameState.phase.type === PhaseType.Builds) {
          await (client.game.submitBuilds.mutate as (input: unknown) => Promise<unknown>)({
            builds: [],
          });
        }
      } catch (err) {
        logger.error(`[${power}] Auto-submit error:`, err);
      }
    }
  }

  // ── Message batch handler ─────────────────────────────────────────

  async function handleMessageBatch(newMessages: Message[]) {
    try {
      const state = await client.game.getState.query({ lobbyId });
      const serialized = state as SerializedGameState;
      if (serialized.gameOver) {
        logger.info(`[${power}] Game over detected, skipping message batch`);
        return;
      }

      const gameState = deserializeGameState(serialized);

      if (!llm.runToolLoop) {
        logger.error(`[${power}] LLM client does not support tool calling`);
        return;
      }

      const executor = new GameToolExecutor(client as unknown as ToolGameClient, gameState, power);
      const tools = filterTools(gameState.phase.type, ['sendMessage']);
      // Pass ALL accumulated messages so the agent has full diplomatic context
      const messagePlan = await readPlan();
      const userMessage = buildTurnPrompt(gameState, power, accumulatedMessages, messagePlan);

      logger.info(
        `[${power}] Starting tool loop for ${newMessages.length} new message(s) (${accumulatedMessages.length} total context)`,
      );
      try {
        await llm.runToolLoop(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          tools,
          executor,
        );
      } catch (err) {
        logger.error(`[${power}] Message batch tool loop error:`, err);
      }
    } catch (err) {
      logger.error(`[${power}] handleMessageBatch error:`, err);
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  const subs: Unsubscribable[] = [];
  let lastHandledPhase = '';

  function phaseKey(gs: GameState): string {
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
          logger.warn(`[${power}] Unexpected phase envelope shape, skipping`);
          return;
        }
        const gameState = deserializeGameState(tracked.data.gameState);
        const key = phaseKey(gameState);
        if (key === lastHandledPhase) return;
        lastHandledPhase = key;
        enqueuePhase(
          gameState,
          tracked.data.gameState.deadlineMs ?? 0,
          tracked.data.gameState.availableActions,
        );
      },
      onError(err) {
        logger.error(`[${power}] onPhaseChange subscription error:`, err);
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
          logger.warn(`[${power}] Unexpected message envelope shape, skipping`);
          return;
        }
        const message = tracked.data;
        if (message.from === power) return;
        const to = typeof message.to === 'string' ? message.to : message.to.join(', ');
        logger.info(`[${power}] <- ${message.from} -> ${to}: ${message.content}`);
        enqueueMessage(message);
      },
      onError(err) {
        logger.error(`[${power}] onMessage subscription error:`, err);
      },
    },
  );
  subs.push(msgSub);

  let unsubscribed = false;
  const unsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    for (const sub of subs) sub.unsubscribe();
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    process.removeListener('SIGINT', onSigint);
    logger.info(`[${power}] Disconnected from server`);
  };

  const onSigint = () => {
    unsubscribe();
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  logger.info(`[${power}] Connected to remote server, listening for phase changes`);

  // Catch up: act on the current phase if we missed the SSE event
  try {
    const currentState = await client.game.getState.query({ lobbyId });
    const serialized = currentState as SerializedGameState;
    if (serialized.gameOver) {
      logger.info(`[${power}] Game is already over, disconnecting`);
      unsubscribe();
      return { unsubscribe };
    }
    const currentGameState = deserializeGameState(serialized);
    const key = phaseKey(currentGameState);
    if (
      key !== lastHandledPhase &&
      (currentGameState.phase.type === PhaseType.Orders ||
        currentGameState.phase.type === PhaseType.Retreats ||
        currentGameState.phase.type === PhaseType.Builds)
    ) {
      lastHandledPhase = key;
      logger.info(`[${power}] Catching up on current phase: ${currentGameState.phase.type}`);
      enqueuePhase(currentGameState, serialized.deadlineMs, serialized.availableActions);
    }
  } catch (err) {
    logger.error(`[${power}] catch-up error (non-fatal):`, err);
  }

  return { unsubscribe };
}
