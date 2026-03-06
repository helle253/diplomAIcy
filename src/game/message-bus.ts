import { Message, Phase, Power } from '../engine/types.js';

export type MessageListener = (message: Message) => void;

export class MessageBus {
  private messages: Message[] = [];
  private listeners: MessageListener[] = [];
  private _phase: Phase | null = null;

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
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  /** Get all messages sent during this bus's lifetime */
  getMessages(): Message[] {
    return this.messages;
  }

  /** Get messages addressed to a specific power */
  getMessagesFor(power: Power): Message[] {
    return this.messages.filter(
      (m) =>
        m.to === 'Global' ||
        m.to === power ||
        (Array.isArray(m.to) && m.to.includes(power)),
    );
  }

  private stamp(msg: Message): void {
    if (!this._phase) throw new Error('MessageBus: phase not set');
    msg.phase = { ...this._phase };
    msg.timestamp = Date.now();
  }
}
