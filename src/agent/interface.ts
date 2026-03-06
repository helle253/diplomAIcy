import {
  BuildOrder,
  GameState,
  Message,
  Order,
  Power,
  RetreatOrder,
  RetreatSituation,
} from '../engine/types.js';

export interface DiplomacyAgent {
  power: Power;

  // Called at the start of a game with game info
  initialize(gameState: GameState): Promise<void>;

  // Generate opening messages at the start of a diplomacy phase
  // These are sent through the MessageBus to kick off negotiation
  openNegotiation(gameState: GameState): Promise<Message[]>;

  // Called when a message is pushed to this agent via the MessageBus
  // Return messages to send in response (pushed back through the bus)
  onMessage(message: Message, gameState: GameState): Promise<Message[]>;

  // Submit orders for the current phase
  submitOrders(gameState: GameState): Promise<Order[]>;

  // Submit retreat orders when units are dislodged
  submitRetreats(
    gameState: GameState,
    retreatSituations: RetreatSituation[],
  ): Promise<RetreatOrder[]>;

  // Submit build/disband orders in Winter
  // buildCount > 0 means builds available, < 0 means must disband
  submitBuilds(gameState: GameState, buildCount: number): Promise<BuildOrder[]>;
}
