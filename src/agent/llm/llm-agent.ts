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
    this.messageHistory = [];
    this.responsesThisPhase = 0;
    this.currentPhaseKey = '';
  }

  async openNegotiation(gameState: GameState): Promise<Message[]> {
    this.resetPhaseCounter(gameState);

    try {
      const prompt = buildNegotiationPrompt(gameState, this.power, this.recentMessages());
      const response = await this.complete(prompt);
      const messages = parseMessages(response, this.power, gameState.phase);
      this.trackMessages(messages);
      return messages;
    } catch (err) {
      console.error(`[${this.power}] openNegotiation error:`, err);
      return [];
    }
  }

  async onMessage(message: Message, gameState: GameState): Promise<Message[]> {
    this.messageHistory.push(message);

    // Rate limit responses per phase
    if (MAX_RESPONSES_PER_PHASE >= 0 && this.responsesThisPhase >= MAX_RESPONSES_PER_PHASE) {
      return [];
    }

    try {
      const prompt = buildNegotiationPrompt(gameState, this.power, this.recentMessages(), message);
      const response = await this.complete(prompt);
      const messages = parseMessages(response, this.power, gameState.phase);
      this.responsesThisPhase += messages.length;
      this.trackMessages(messages);
      return messages;
    } catch (err) {
      console.error(`[${this.power}] onMessage error:`, err);
      return [];
    }
  }

  async submitOrders(gameState: GameState): Promise<Order[]> {
    try {
      const prompt = buildOrdersPrompt(gameState, this.power, this.recentMessages());
      const response = await this.complete(prompt);
      return parseOrders(response, gameState, this.power);
    } catch (err) {
      console.error(`[${this.power}] submitOrders error:`, err);
      // Fall back to all Hold
      return gameState.units
        .filter((u) => u.power === this.power)
        .map((u) => ({ type: OrderType.Hold, unit: u.province }));
    }
  }

  async submitRetreats(
    gameState: GameState,
    retreatSituations: RetreatSituation[],
  ): Promise<RetreatOrder[]> {
    try {
      const prompt = buildRetreatsPrompt(gameState, this.power, retreatSituations);
      const response = await this.complete(prompt);
      return parseRetreats(response, retreatSituations, this.power);
    } catch (err) {
      console.error(`[${this.power}] submitRetreats error:`, err);
      // Fall back to disband all
      return retreatSituations
        .filter((s) => s.unit.power === this.power)
        .map((s) => ({ type: 'Disband' as const, unit: s.unit.province }));
    }
  }

  async submitBuilds(gameState: GameState, buildCount: number): Promise<BuildOrder[]> {
    try {
      const prompt = buildBuildsPrompt(gameState, this.power, buildCount);
      const response = await this.complete(prompt);
      return parseBuildOrders(response, gameState, this.power, buildCount);
    } catch (err) {
      console.error(`[${this.power}] submitBuilds error:`, err);
      if (buildCount > 0) {
        return Array.from({ length: buildCount }, () => ({ type: 'Waive' as const }));
      }
      // Force remove from end
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
