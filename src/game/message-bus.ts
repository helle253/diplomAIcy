import { Message, Phase, Power } from '../engine/types.js';

export type MessageListener = (message: Message) => void;

export interface MessageBusConfig {
  pressDelayMin?: number;
  pressDelayMax?: number;
}

export class MessageBus {
  private messages: Message[] = [];
  private listeners: MessageListener[] = [];
  private _phase: Phase | null = null;
  private pressDelayMin: number;
  private pressDelayMax: number;
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(config: MessageBusConfig = {}) {
    this.pressDelayMin = config.pressDelayMin ?? 0;
    this.pressDelayMax = config.pressDelayMax ?? 0;
    if (this.pressDelayMin > this.pressDelayMax) {
      throw new Error(
        `MessageBus: pressDelayMin (${this.pressDelayMin}) must be <= pressDelayMax (${this.pressDelayMax})`,
      );
    }
  }

  set phase(phase: Phase) {
    this._phase = { ...phase };
  }

  get currentPhase(): Phase | null {
    return this._phase;
  }

  /** Register a listener that sees every message (for UI broadcast, logging, agent delivery) */
  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  /** Send a message — stamps it with the current phase, stores, and notifies listeners */
  send(message: Message): void {
    this.stamp(message);
    this.messages.push(message);
    this.notifyListeners(message);
  }

  /** Get all messages sent during this bus's lifetime */
  getMessages(): Message[] {
    return this.messages;
  }

  /** Get messages addressed to a specific power */
  getMessagesFor(power: Power): Message[] {
    return this.messages.filter(
      (m) => m.to === 'Global' || m.to === power || (Array.isArray(m.to) && m.to.includes(power)),
    );
  }

  /** Cancel all pending delayed deliveries */
  destroy(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers = [];
  }

  private notifyListeners(message: Message): void {
    if (this.pressDelayMin <= 0 && this.pressDelayMax <= 0) {
      for (const listener of this.listeners) {
        listener(message);
      }
      return;
    }

    const delay = this.pressDelayMin + Math.random() * (this.pressDelayMax - this.pressDelayMin);

    const timer = setTimeout(() => {
      this.pendingTimers = this.pendingTimers.filter((t) => t !== timer);
      for (const listener of this.listeners) {
        listener(message);
      }
    }, delay);

    this.pendingTimers.push(timer);
  }

  private stamp(msg: Message): void {
    if (!this._phase) throw new Error('MessageBus: phase not set');
    msg.phase = { ...this._phase };
    msg.timestamp = Date.now();
  }
}
