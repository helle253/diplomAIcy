import { Power, GameState, Message, Order, RetreatOrder, BuildOrder, RetreatSituation } from '../engine/types.js';

export interface DiplomacyAgent {
  power: Power;

  // Called at the start of a game with game info
  initialize(gameState: GameState): Promise<void>;

  // Negotiation phase: receive messages, return messages to send
  negotiate(gameState: GameState, incomingMessages: Message[]): Promise<Message[]>;

  // Submit orders for the current phase
  submitOrders(gameState: GameState): Promise<Order[]>;

  // Submit retreat orders when units are dislodged
  submitRetreats(gameState: GameState, retreatSituations: RetreatSituation[]): Promise<RetreatOrder[]>;

  // Submit build/disband orders in Winter
  // buildCount > 0 means builds available, < 0 means must disband
  submitBuilds(gameState: GameState, buildCount: number): Promise<BuildOrder[]>;
}
