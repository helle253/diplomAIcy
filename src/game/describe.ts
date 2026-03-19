import { publicProcedure } from './trpc';

/**
 * Self-describing API metadata endpoint.
 * Allows any client (especially LLM agents) to discover the full API surface
 * by calling GET /trpc/describe — no prior knowledge required.
 */
export const describeProcedure = publicProcedure.query(() => ({
  name: 'DiplomAIcy',
  version: '1.0',
  description:
    'Diplomacy game server with lobby management, game play, and real-time subscriptions.',
  auth: {
    mechanism: 'Bearer token in Authorization header',
    howToGetToken: 'Call lobby.join or lobby.create to receive a token',
    note: 'Queries are public. Mutations marked "auth: seatToken" require a player seat token. Mutations marked "auth: creatorToken" require the lobby creator token.',
  },
  procedures: {
    lobby: {
      list: {
        type: 'query',
        input: null,
        description: 'List all lobbies',
      },
      get: {
        type: 'query',
        input: { id: 'string' },
        description: 'Get lobby details including config and seat count',
      },
      create: {
        type: 'mutation',
        input: {
          name: 'string (required)',
          maxYears: 'number (default: none)',
          victoryThreshold: 'number (default: 18)',
          startYear: 'number (default: 1901)',
          phaseDelayMs: 'number (default: 0)',
          remoteTimeoutMs: 'number (default: 0)',
          autostart: 'boolean (default: false)',
          agentConfig: '{ defaultAgent: { type: "random"|"llm"|"remote" } }',
        },
        returns: '{ lobbyId, creatorToken }',
        description: 'Create a new lobby. Returns creatorToken for admin actions.',
      },
      join: {
        type: 'mutation',
        input: { lobbyId: 'string', power: 'Power' },
        returns: '{ seatToken }',
        description: 'Join a lobby as a power. Returns seatToken for game actions.',
      },
      rejoin: {
        type: 'mutation',
        input: { lobbyId: 'string', power: 'Power', oldToken: 'string' },
        returns: '{ seatToken }',
        description: 'Rejoin a lobby with a previous token (for reconnection)',
      },
      start: {
        type: 'mutation',
        auth: 'creatorToken',
        input: null,
        description: 'Start the game (or use autostart: true on create)',
      },
      delete: {
        type: 'mutation',
        auth: 'creatorToken',
        input: null,
        description: 'Delete the lobby',
      },
      kick: {
        type: 'mutation',
        auth: 'creatorToken',
        input: { power: 'Power' },
        description: 'Kick a player from the lobby',
      },
      getDefaults: {
        type: 'query',
        input: null,
        description: 'Get default lobby configuration values',
      },
    },
    game: {
      getState: {
        type: 'query',
        input: { lobbyId: 'string' },
        description:
          'Full game state: phase, map, powers summary, orderHistory, retreatSituations, deadlineMs, gameOver',
      },
      getPhase: {
        type: 'query',
        input: { lobbyId: 'string' },
        description: 'Current phase string (e.g. "Spring 1901 Orders")',
      },
      getBuildCount: {
        type: 'query',
        input: { lobbyId: 'string', power: 'Power' },
        description: 'How many units to build (positive) or remove (negative)',
      },
      getRules: {
        type: 'query',
        input: { lobbyId: 'string' },
        description:
          'Full Diplomacy rules text with game-specific values (victory threshold, end year, deadlines)',
      },
      getSchemas: {
        type: 'query',
        input: null,
        description: 'JSON schemas for order, retreat, and build payloads',
      },
      getActivePowers: {
        type: 'query',
        input: { lobbyId: 'string' },
        description: 'List of powers still in the game (with units)',
      },
      submitOrders: {
        type: 'mutation',
        auth: 'seatToken',
        input: { orders: 'Order[]' },
        description: 'Submit orders for the current phase. Call getSchemas for Order shape.',
      },
      submitRetreats: {
        type: 'mutation',
        auth: 'seatToken',
        input: { retreats: 'RetreatOrder[]' },
        description: 'Submit retreat orders. Call getSchemas for RetreatOrder shape.',
      },
      submitBuilds: {
        type: 'mutation',
        auth: 'seatToken',
        input: { builds: 'BuildOrder[]' },
        description: 'Submit build/remove orders. Call getSchemas for BuildOrder shape.',
      },
      sendMessage: {
        type: 'mutation',
        auth: 'seatToken',
        input: { to: 'Power | Power[] | "Global"', content: 'string' },
        description: 'Send a diplomatic message to one or more powers, or broadcast globally',
      },
      onPhaseChange: {
        type: 'subscription',
        transport: 'SSE (httpSubscriptionLink) or WebSocket',
        input: { lobbyId: 'string' },
        description: 'Real-time phase change events with full game state',
      },
      onMessage: {
        type: 'subscription',
        transport: 'SSE (httpSubscriptionLink) or WebSocket',
        input: { lobbyId: 'string' },
        description:
          'Real-time diplomatic messages. Authenticated: receives messages to your power. Unauthenticated: broadcasts only.',
      },
    },
  },
  powers: ['England', 'France', 'Germany', 'Italy', 'Austria', 'Russia', 'Turkey'],
  quickstart: [
    '1. GET  /trpc/describe                          — you are here',
    '2. POST /trpc/lobby.create                      — create a lobby, get creatorToken',
    '3. POST /trpc/lobby.join                        — join as a power, get seatToken',
    '4. GET  /trpc/game.getRules?input={lobbyId}     — read the rules',
    '5. GET  /trpc/game.getSchemas                   — get order JSON schemas',
    '6. GET  /trpc/game.getState?input={lobbyId}     — poll game state',
    '7. POST /trpc/game.submitOrders                 — submit orders (Bearer seatToken)',
  ],
}));
