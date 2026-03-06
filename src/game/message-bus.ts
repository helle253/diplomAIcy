import { Message, Phase, Power } from '../engine/types.js';

export type MessageHandler = (message: Message) => Promise<Message[]>;
export type MessageListener = (message: Message) => void;

/** Resolve the recipient list for a message into individual powers */
function resolveRecipients(msg: Message, allPowers: Power[]): Power[] {
  if (msg.to === 'Global') {
    return allPowers.filter((p) => p !== msg.from);
  }
  if (Array.isArray(msg.to)) {
    return msg.to.filter((p) => p !== msg.from);
  }
  return [msg.to];
}

export class MessageBus {
  private handlers: Map<Power, MessageHandler> = new Map();
  private listeners: MessageListener[] = [];
  private messages: Message[] = [];
  private phase: Phase;
  private processing = false;
  private queue: Message[] = [];

  constructor(phase: Phase) {
    this.phase = phase;
  }

  /** Register a power's handler — called when a message is addressed to them */
  registerHandler(power: Power, handler: MessageHandler): void {
    this.handlers.set(power, handler);
  }

  /** Register a listener that sees every message (for UI broadcast, logging) */
  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  /** Send a message through the bus. Delivers to recipients who can respond. */
  async send(message: Message): Promise<void> {
    this.stamp(message);
    this.record(message);
    this.queue.push(message);
    if (!this.processing) {
      await this.processQueue();
    }
  }

  /** Send multiple messages at once */
  async sendAll(messages: Message[]): Promise<void> {
    for (const msg of messages) {
      this.stamp(msg);
      this.record(msg);
      this.queue.push(msg);
    }
    if (!this.processing) {
      await this.processQueue();
    }
  }

  private stamp(msg: Message): void {
    msg.phase = { ...this.phase };
    msg.timestamp = Date.now();
  }

  private record(msg: Message): void {
    this.messages.push(msg);
    for (const listener of this.listeners) {
      listener(msg);
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    const allPowers = [...this.handlers.keys()];

    while (this.queue.length > 0) {
      const batch = [...this.queue];
      this.queue = [];

      // Group messages by recipient power
      const byRecipient = new Map<Power, Message[]>();
      for (const msg of batch) {
        const recipients = resolveRecipients(msg, allPowers);
        for (const power of recipients) {
          const list = byRecipient.get(power) ?? [];
          list.push(msg);
          byRecipient.set(power, list);
        }
      }

      // Deliver to each recipient in parallel, collect responses
      const deliveries = [...byRecipient.entries()].map(async ([power, msgs]) => {
        const handler = this.handlers.get(power);
        if (!handler) return;
        for (const msg of msgs) {
          const responses = await handler(msg);
          for (const resp of responses) {
            this.stamp(resp);
            this.record(resp);
            this.queue.push(resp);
          }
        }
      });

      await Promise.all(deliveries);
    }
    this.processing = false;
  }

  /** Get all messages sent during this bus's lifetime */
  getMessages(): Message[] {
    return this.messages;
  }
}
