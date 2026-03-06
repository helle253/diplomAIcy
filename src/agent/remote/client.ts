import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { EventSource } from 'eventsource';

import type { GameRouter } from '../../game/router.js';

/**
 * Creates a typed tRPC client that connects to the game server.
 * Uses httpBatchLink for queries/mutations and httpSubscriptionLink (SSE) for subscriptions.
 */
export function createGameClient(serverUrl: string) {
  return createTRPCClient<GameRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: serverUrl,
          EventSource: EventSource as unknown as typeof globalThis.EventSource,
        }),
        false: httpBatchLink({ url: serverUrl }),
      }),
    ],
  });
}

export type GameClient = ReturnType<typeof createGameClient>;
