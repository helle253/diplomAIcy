import {
  BuildOrder,
  GameState,
  Message,
  Order,
  Power,
  RetreatOrder,
  RetreatSituation,
} from '../engine/types.js';

/** Result from batch message processing — replies to send now, deferred messages to revisit later */
export interface BatchMessageResult {
  replies: Message[];
  deferred: Message[]; // incoming messages the agent chose not to handle yet
}

export interface DiplomacyAgent {
  power: Power;

  // Called at the start of a game with game info
  initialize(gameState: GameState): Promise<void>;

  // Called at the start of every phase — return messages to send (press is always open)
  onPhaseStart(gameState: GameState): Promise<Message[]>;

  // Called when a message is pushed to this agent via the MessageBus
  // Return messages to send in response (pushed back through the bus)
  onMessage(message: Message, gameState: GameState): Promise<Message[]>;

  // Called with a batch of accumulated messages — single LLM call for all
  // Optional: if not implemented, falls back to calling onMessage per message
  // Deferred messages are re-queued for the next batch
  onMessages?(messages: Message[], gameState: GameState): Promise<BatchMessageResult>;

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
