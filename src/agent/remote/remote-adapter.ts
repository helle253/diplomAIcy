import type { Unsubscribable } from '@trpc/server/observable';

import type { Message } from '../../engine/types.js';
import { PhaseType } from '../../engine/types.js';
import { logger } from '../../util/logger.js';
import type { DiplomacyAgent } from '../interface.js';
import type { GameClient } from './client.js';
import { deserializeGameState, type SerializedGameState } from './deserialize.js';

/**
 * Connects a DiplomacyAgent to a remote game server via tRPC.
 * Mirrors the in-process adapter but communicates over HTTP/SSE.
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

  const subs: Unsubscribable[] = [];

  // 2. Subscribe to phase changes
  const phaseSub = client.onPhaseChange.subscribe(undefined, {
    onData(envelope) {
      // TrackedEnvelope is { id, data }
      const tracked = envelope as unknown as { id: string; data: { gameState: SerializedGameState } };
      const gameState = deserializeGameState(tracked.data.gameState);

      (async () => {
        // Let agent send press
        try {
          const messages = await agent.onPhaseStart(gameState);
          for (const msg of messages) {
            await client.sendMessage.mutate({
              from: msg.from,
              to: msg.to,
              content: msg.content,
            });
          }
        } catch (err) {
          logger.error(`[${agent.power}] onPhaseStart error:`, err);
        }

        // Submit phase-appropriate actions
        try {
          if (gameState.phase.type === PhaseType.Orders) {
            logger.info(`[${agent.power}] submitOrders`);
            const orders = await agent.submitOrders(gameState);
            logger.info(`[${agent.power}] submitOrders complete, ${orders.length} orders`);
            await client.submitOrders.mutate({ power: agent.power, orders });
          } else if (gameState.phase.type === PhaseType.Retreats) {
            logger.info(`[${agent.power}] submitRetreats`);
            const retreats = await agent.submitRetreats(gameState, gameState.retreatSituations);
            logger.info(`[${agent.power}] submitRetreats complete, ${retreats.length} orders`);
            await client.submitRetreats.mutate({ power: agent.power, retreats });
          } else if (gameState.phase.type === PhaseType.Builds) {
            const { buildCount } = await client.getBuildCount.query({ power: agent.power });
            if (buildCount !== 0) {
              logger.info(`[${agent.power}] submitBuilds (buildCount=${buildCount})`);
              const builds = await agent.submitBuilds(gameState, buildCount);
              logger.info(`[${agent.power}] submitBuilds complete, ${builds.length} orders`);
              await client.submitBuilds.mutate({ power: agent.power, builds });
            }
          }
        } catch (err) {
          logger.error(`[${agent.power}] phase action error:`, err);
        }
      })();
    },
    onError(err) {
      logger.error(`[${agent.power}] onPhaseChange subscription error:`, err);
    },
  });
  subs.push(phaseSub);

  // 3. Subscribe to messages addressed to this agent
  const msgSub = client.onMessage.subscribe(
    { power: agent.power },
    {
      onData(envelope) {
        const tracked = envelope as unknown as { id: string; data: Message };
        const message = tracked.data;

        // Skip messages from self
        if (message.from === agent.power) return;

        (async () => {
          try {
            const state = await client.getState.query();
            const gameState = deserializeGameState(state as SerializedGameState);
            const replies = await agent.onMessage(message, gameState);
            for (const reply of replies) {
              await client.sendMessage.mutate({
                from: reply.from,
                to: reply.to,
                content: reply.content,
              });
            }
          } catch (err) {
            logger.error(`[${agent.power}] onMessage error:`, err);
          }
        })();
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

  // Handle SIGINT for clean shutdown
  process.on('SIGINT', () => {
    unsubscribe();
    process.exit(0);
  });

  logger.info(`[${agent.power}] Connected to remote server, listening for phase changes`);
  return { unsubscribe };
}
