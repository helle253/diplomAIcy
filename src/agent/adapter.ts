import { PhaseType } from '../engine/types';
import { GameManager } from '../game/manager';
import { logger } from '../util/logger';
import { DiplomacyAgent } from './interface';

/**
 * Connects a DiplomacyAgent to a GameManager, bridging the two interfaces.
 * The agent reacts to phase changes and messages, submitting actions back to the manager.
 */
export function connectAgent(agent: DiplomacyAgent, manager: GameManager): void {
  // React to phase changes
  manager.onPhaseChange(async (phase, gameState) => {
    // Let the agent send press at the start of every phase
    try {
      const messages = await agent.onPhaseStart(gameState);
      for (const msg of messages) {
        manager.sendMessage(msg);
      }
    } catch (err) {
      logger.error(`[${agent.power}] onPhaseStart error:`, err);
    }

    // Submit appropriate actions based on phase type
    try {
      if (phase.type === PhaseType.Orders) {
        logger.info(`[${agent.power}] submitOrders`);
        const orders = await agent.submitOrders(gameState);
        logger.info(`[${agent.power}] submitOrders complete, ${orders.length} orders`);
        manager.submitOrders(agent.power, orders);
      } else if (phase.type === PhaseType.Retreats) {
        logger.info(`[${agent.power}] submitRetreats`);
        const retreats = await agent.submitRetreats(gameState, gameState.retreatSituations);
        logger.info(`[${agent.power}] submitRetreats complete, ${retreats.length} orders`);
        manager.submitRetreats(agent.power, retreats);
      } else if (phase.type === PhaseType.Builds) {
        const buildCount = manager.getBuildCount(agent.power);
        if (buildCount !== 0) {
          logger.info(`[${agent.power}] submitBuilds (buildCount=${buildCount})`);
          const builds = await agent.submitBuilds(gameState, buildCount);
          logger.info(`[${agent.power}] submitBuilds complete, ${builds.length} orders`);
          manager.submitBuilds(agent.power, builds);
        }
      }
    } catch (err) {
      logger.error(`[${agent.power}] phase action error:`, err);
    }
  });

  // Deliver messages to the agent
  manager.onMessage(async (message) => {
    // Skip messages from self
    if (message.from === agent.power) return;

    // Check if this agent is a recipient
    const isRecipient =
      message.to === 'Global' ||
      message.to === agent.power ||
      (Array.isArray(message.to) && message.to.includes(agent.power));

    if (!isRecipient) return;

    try {
      const replies = await agent.onMessage(message, manager.getState());
      for (const reply of replies) {
        manager.sendMessage(reply);
      }
    } catch (err) {
      logger.error(`[${agent.power}] onMessage error:`, err);
    }
  });
}
