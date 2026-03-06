import {
  BuildOrder,
  GameState,
  Message,
  Order,
  OrderType,
  Power,
  RetreatOrder,
  RetreatSituation,
} from '../../engine/types.js';
import { logger } from '../../util/logger.js';
import { DiplomacyAgent } from '../interface.js';
import { ChatMessage, LLMClient } from './llm-client.js';
import { parseBuildOrders, parseMessages, parseOrders, parseRetreats } from './order-parser.js';
import {
  buildBuildsPrompt,
  buildNegotiationPrompt,
  buildOrdersPrompt,
  buildRetreatsPrompt,
  buildSystemPrompt,
} from './prompts.js';

const MAX_RESPONSES_PER_PHASE = -1;

export class LLMAgent implements DiplomacyAgent {
  power: Power;
  private client: LLMClient;
  private systemPrompt: string;
  private messageHistory: Message[] = [];
  private responsesThisPhase = 0;
  private currentPhaseKey = '';

  constructor(power: Power, client: LLMClient) {
    this.power = power;
    this.client = client;
    this.systemPrompt = buildSystemPrompt(power);
  }

  async initialize(_gameState: GameState): Promise<void> {
    logger.info(`[${this.power}] LLMAgent.initialize`);
    this.messageHistory = [];
    this.responsesThisPhase = 0;
    this.currentPhaseKey = '';
  }

  async openNegotiation(gameState: GameState): Promise<Message[]> {
    logger.info(
      `[${this.power}] LLMAgent.openNegotiation (${gameState.phase.season} ${gameState.phase.year})`,
    );
    this.resetPhaseCounter(gameState);

    try {
      const prompt = buildNegotiationPrompt(gameState, this.power, this.recentMessages());
      const response = await this.complete(prompt);
      const messages = parseMessages(response, this.power, gameState.phase);
      this.trackMessages(messages);
      logger.info(`[${this.power}] LLMAgent.openNegotiation produced ${messages.length} messages`);
      return messages;
    } catch (err) {
      logger.error(`[${this.power}] LLMAgent.openNegotiation error:`, err);
      logger.warn(`[${this.power}] LLMAgent.openNegotiation falling back to no messages`);
      return [];
    }
  }

  async onMessage(message: Message, gameState: GameState): Promise<Message[]> {
    logger.info(`[${this.power}] LLMAgent.onMessage from ${message.from}`);
    this.messageHistory.push(message);

    // Rate limit responses per phase
    if (MAX_RESPONSES_PER_PHASE >= 0 && this.responsesThisPhase >= MAX_RESPONSES_PER_PHASE) {
      logger.info(
        `[${this.power}] LLMAgent.onMessage rate-limited (${this.responsesThisPhase}/${MAX_RESPONSES_PER_PHASE})`,
      );
      return [];
    }

    try {
      const prompt = buildNegotiationPrompt(gameState, this.power, this.recentMessages(), message);
      const response = await this.complete(prompt);
      const messages = parseMessages(response, this.power, gameState.phase);
      this.responsesThisPhase += messages.length;
      this.trackMessages(messages);
      logger.info(`[${this.power}] LLMAgent.onMessage produced ${messages.length} replies`);
      return messages;
    } catch (err) {
      logger.error(`[${this.power}] LLMAgent.onMessage error:`, err);
      logger.warn(`[${this.power}] LLMAgent.onMessage falling back to no replies`);
      return [];
    }
  }

  async submitOrders(gameState: GameState): Promise<Order[]> {
    const myUnitCount = gameState.units.filter((u) => u.power === this.power).length;
    logger.info(`[${this.power}] LLMAgent.submitOrders (${myUnitCount} units)`);
    try {
      const prompt = buildOrdersPrompt(gameState, this.power, this.recentMessages());
      const response = await this.complete(prompt);
      const orders = parseOrders(response, gameState, this.power);
      logger.info(`[${this.power}] LLMAgent.submitOrders produced ${orders.length} orders`);
      return orders;
    } catch (err) {
      logger.error(`[${this.power}] LLMAgent.submitOrders error:`, err);
      logger.warn(`[${this.power}] LLMAgent.submitOrders falling back to all Hold`);
      return gameState.units
        .filter((u) => u.power === this.power)
        .map((u) => ({ type: OrderType.Hold, unit: u.province }));
    }
  }

  async submitRetreats(
    gameState: GameState,
    retreatSituations: RetreatSituation[],
  ): Promise<RetreatOrder[]> {
    const myRetreats = retreatSituations.filter((s) => s.unit.power === this.power);
    logger.info(`[${this.power}] LLMAgent.submitRetreats (${myRetreats.length} dislodged units)`);
    try {
      const prompt = buildRetreatsPrompt(gameState, this.power, retreatSituations);
      const response = await this.complete(prompt);
      const orders = parseRetreats(response, retreatSituations, this.power);
      logger.info(`[${this.power}] LLMAgent.submitRetreats produced ${orders.length} orders`);
      return orders;
    } catch (err) {
      logger.error(`[${this.power}] LLMAgent.submitRetreats error:`, err);
      logger.warn(`[${this.power}] LLMAgent.submitRetreats falling back to disband all`);
      return myRetreats.map((s) => ({ type: 'Disband' as const, unit: s.unit.province }));
    }
  }

  async submitBuilds(gameState: GameState, buildCount: number): Promise<BuildOrder[]> {
    logger.info(`[${this.power}] LLMAgent.submitBuilds (buildCount=${buildCount})`);
    try {
      const prompt = buildBuildsPrompt(gameState, this.power, buildCount);
      const response = await this.complete(prompt);
      const orders = parseBuildOrders(response, gameState, this.power, buildCount);
      logger.info(`[${this.power}] LLMAgent.submitBuilds produced ${orders.length} orders`);
      return orders;
    } catch (err) {
      logger.error(`[${this.power}] LLMAgent.submitBuilds error:`, err);
      logger.warn(
        `[${this.power}] LLMAgent.submitBuilds falling back to ${buildCount > 0 ? 'waive' : 'remove'}`,
      );
      if (buildCount > 0) {
        return Array.from({ length: buildCount }, () => ({ type: 'Waive' as const }));
      }
      const myUnits = gameState.units.filter((u) => u.power === this.power);
      return myUnits
        .slice(-Math.abs(buildCount))
        .map((u) => ({ type: 'Remove' as const, unit: u.province }));
    }
  }

  private async complete(userPrompt: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    return this.client.complete(messages);
  }

  private resetPhaseCounter(gameState: GameState): void {
    const key = `${gameState.phase.year}-${gameState.phase.season}-${gameState.phase.type}`;
    if (key !== this.currentPhaseKey) {
      this.currentPhaseKey = key;
      this.responsesThisPhase = 0;
    }
  }

  private recentMessages(): Message[] {
    return this.messageHistory.slice(-15);
  }

  private trackMessages(messages: Message[]): void {
    this.messageHistory.push(...messages);
  }
}
