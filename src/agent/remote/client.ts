import { createTRPCClient, httpLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { EventSource } from 'eventsource';

import type { AppRouter } from '../../ui/server.js';

/**
 * Creates a typed tRPC client that connects to the game server.
 * Uses httpLink for queries/mutations and httpSubscriptionLink (SSE) for subscriptions.
 */
export function createGameClient(serverUrl: string, token?: string) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const sseUrl = token
    ? `${serverUrl}${serverUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : serverUrl;

  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: sseUrl,
          EventSource: EventSource as unknown as typeof globalThis.EventSource,
        }),
        false: httpLink({
          url: serverUrl,
          headers,
        }),
      }),
    ],
  });
}

export type GameClient = ReturnType<typeof createGameClient>;
