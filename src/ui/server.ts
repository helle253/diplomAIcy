import 'dotenv/config';

import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { AnthropicClient } from '../agent/llm/anthropic-client';
import type { GameConfig } from '../agent/llm/config';
import { getAgentConfig, loadConfig, toLLMClientConfig } from '../agent/llm/config';
import { OpenAICompatibleClient } from '../agent/llm/llm-client';
import { connectToolAgent } from '../agent/llm/tool-agent';
import { connectRandomAgent } from '../agent/random-agent';
import { createGameClient } from '../agent/remote/client';
import { Message, Power } from '../engine/types';
import { describeProcedure } from '../game/describe';
import { LobbyManager } from '../game/lobby-manager';
import { createLobbyRouter } from '../game/lobby-router';
import type { GameEvent, TurnRecord } from '../game/manager';
import { createGameRouter } from '../game/router';
import { GameStorage } from '../game/storage';
import { createContext, router } from '../game/trpc';
import { logger } from '../util/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000');
const DB_PATH = process.env.DB_PATH || 'diplomaicy.db';

const ALL_POWERS: Power[] = [
  Power.England,
  Power.France,
  Power.Germany,
  Power.Italy,
  Power.Austria,
  Power.Russia,
  Power.Turkey,
];

function serializeState(state: import('../engine/types.js').GameState) {
  return {
    ...state,
    supplyCenters: Object.fromEntries(state.supplyCenters),
  };
}

// A snapshot of the game at a specific phase, for the slider
interface PhaseSnapshot {
  phase: { year: number; season: string; type: string };
  gameState: ReturnType<typeof serializeState>;
  turnRecord?: TurnRecord;
  messages: Message[]; // cumulative messages up to this phase
}

// Per-lobby runtime state
interface LobbyRuntime {
  phaseSnapshots: PhaseSnapshot[];
  allMessages: Message[];
  gameId: string;
  clients: Map<WebSocket, Power | undefined>; // ws → power (undefined = spectator)
  agentConnections: Array<{ unsubscribe: () => void }>;
}

const lobbyRuntimes = new Map<string, LobbyRuntime>();

function cleanupLobbyRuntime(lobbyId: string): void {
  const runtime = lobbyRuntimes.get(lobbyId);
  if (!runtime) return;
  for (const conn of runtime.agentConnections) {
    try {
      conn.unsubscribe();
    } catch {
      // Agent may already be disconnected
    }
  }
  for (const client of runtime.clients.keys()) {
    client.close();
  }
  lobbyRuntimes.delete(lobbyId);
}

function broadcastToLobby(
  lobbyId: string,
  data: unknown,
  filter?: (power: Power | undefined) => boolean,
): void {
  const runtime = lobbyRuntimes.get(lobbyId);
  if (!runtime) return;
  const message = JSON.stringify(data);
  for (const [client, power] of runtime.clients) {
    if (client.readyState === WebSocket.OPEN && (!filter || filter(power))) {
      client.send(message);
    }
  }
}

function startServer(): void {
  const app = express();
  const server = createServer(app);
  const storage = new GameStorage(DB_PATH);

  // Load defaults from env vars + config file
  const maxYears = parseInt(process.env.MAX_YEARS || '10');
  const phaseDelayMs = parseInt(process.env.PHASE_DELAY || '600000');
  const remoteTimeoutMs = parseInt(process.env.REMOTE_TIMEOUT || '0');
  const pressDelayMin = parseInt(process.env.PRESS_DELAY_MIN || '0');
  const pressDelayMax = parseInt(process.env.PRESS_DELAY_MAX || '0');
  const fastAdjudication = process.env.FAST_ADJUDICATION !== 'false';
  const defaultAgentConfig: GameConfig = loadConfig();
  const defaults = {
    maxYears,
    phaseDelayMs,
    remoteTimeoutMs,
    pressDelayMin,
    pressDelayMax,
    fastAdjudication,
    agentConfig: defaultAgentConfig,
  };

  // Create LobbyManager
  const lobbyManager = new LobbyManager();

  // Register onStart callback to wire agents and game events
  lobbyManager.onStart(async (id, manager) => {
    const lobby = lobbyManager.getLobby(id)!;

    // Create game record in SQLite
    const gameId = storage.createGame();

    // Create LobbyRuntime
    const runtime: LobbyRuntime = {
      phaseSnapshots: [],
      allMessages: [],
      gameId,
      clients: new Map(),
      agentConnections: [],
    };
    lobbyRuntimes.set(id, runtime);

    // Register manager listeners BEFORE wiring agents so no early events are missed
    manager.onMessage((message: Message) => {
      message.gameId = gameId;
      storage.saveMessage(gameId, message);
      runtime.allMessages.push(message);
      broadcastToLobby(id, { type: 'message', message }, (clientPower) => {
        if (message.to === 'Global') return true;
        if (!clientPower) return false; // spectators don't see private press
        if (message.to === clientPower) return true;
        if (message.from === clientPower) return true;
        if (Array.isArray(message.to) && message.to.includes(clientPower)) return true;
        return false;
      });
    });

    manager.onEvent((event: GameEvent) => {
      if (event.turnRecord) {
        storage.saveTurnRecord(gameId, event.turnRecord);
      }

      const snapshot: PhaseSnapshot = {
        phase: event.phase,
        gameState: serializeState(event.gameState),
        turnRecord: event.turnRecord,
        messages: [...runtime.allMessages],
      };
      runtime.phaseSnapshots.push(snapshot);

      // Send per-client filtered snapshots to avoid leaking private press
      const snapshotIndex = runtime.phaseSnapshots.length - 1;
      for (const [client, clientPower] of runtime.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        client.send(
          JSON.stringify({
            type: 'new_phase',
            snapshotIndex,
            snapshot: {
              ...snapshot,
              messages: snapshot.messages.filter((msg) => {
                if (msg.to === 'Global') return true;
                if (!clientPower) return false;
                return (
                  msg.to === clientPower ||
                  msg.from === clientPower ||
                  (Array.isArray(msg.to) && msg.to.includes(clientPower))
                );
              }),
            },
          }),
        );
      }
    });

    // Wire agents (after listeners are registered)
    try {
      for (const power of ALL_POWERS) {
        const agentCfg = getAgentConfig(lobby.config.agentConfig, power);
        if (agentCfg.type === 'remote') {
          logger.info(`  ${power}: Remote (waiting for connection)`);
          continue;
        }

        // Create tRPC client to self (localhost)
        const joinClient = createGameClient(`http://localhost:${PORT}/trpc`);
        const { seatToken } = await joinClient.lobby.join.mutate({ lobbyId: id, power });
        const agentClient = createGameClient(`http://localhost:${PORT}/trpc`, seatToken);

        if (agentCfg.type === 'llm') {
          const llmConfig = toLLMClientConfig(agentCfg);
          const llmClient =
            agentCfg.provider === 'anthropic'
              ? new AnthropicClient(llmConfig)
              : new OpenAICompatibleClient(llmConfig);
          const handle = await connectToolAgent(
            agentClient,
            llmClient,
            power,
            id,
            process.env.PLAN_DIR,
          );
          runtime.agentConnections.push(handle);
          logger.info(
            `  ${power}: LLM tool-calling (${agentCfg.provider ?? 'openai'} / ${toLLMClientConfig(agentCfg).model})`,
          );
        } else {
          const handle = await connectRandomAgent(agentClient, power, id);
          runtime.agentConnections.push(handle);
          logger.info(`  ${power}: Random`);
        }
      }
    } catch (err) {
      storage.failGame(gameId);
      cleanupLobbyRuntime(id);
      throw err;
    }

    logger.info(`Starting new Diplomacy game (${gameId}) for lobby ${id}...`);

    // Run game loop asynchronously (non-blocking)
    manager
      .run()
      .then((result) => {
        storage.completeGame(gameId, result);
        broadcastToLobby(id, {
          type: 'game_end',
          result: {
            ...result,
            supplyCenters: Object.fromEntries(result.supplyCenters),
          },
        });
        lobbyManager.finishLobby(id, result);
        cleanupLobbyRuntime(id);
        logger.info(
          result.winner
            ? `Game over! ${result.winner} wins in ${result.year}.`
            : `Game ended in a draw in year ${result.year}.`,
        );
      })
      .catch((err) => {
        storage.failGame(gameId);
        lobbyManager.finishLobby(id);
        cleanupLobbyRuntime(id);
        logger.error('Game error:', err);
      });
  });

  // Create merged AppRouter
  const lobbyRouter = createLobbyRouter(lobbyManager, defaults);
  const gameRouter = createGameRouter(lobbyManager);
  const appRouter = router({ describe: describeProcedure, lobby: lobbyRouter, game: gameRouter });

  // Serve static files from Vite build output
  // Works with both `tsx src/ui/server.ts` (__dirname=src/ui) and `node dist/ui/server.js` (__dirname=dist/ui)
  const publicDir = existsSync(join(__dirname, 'public'))
    ? join(__dirname, 'public')
    : join(__dirname, '..', '..', 'dist', 'ui', 'public');
  app.use(express.static(publicDir));

  // Health check endpoint (used by scripts to detect server readiness)
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Mount tRPC router
  app.use('/trpc', createExpressMiddleware({ router: appRouter, createContext }));

  // WebSocket with noServer: true
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url || '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const match = url.pathname.match(/^\/ws\/(.+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const lobbyId = match[1];
    const lobby = lobbyManager.getLobby(lobbyId);
    if (!lobby || lobby.status === 'waiting' || lobby.status === 'starting') {
      socket.destroy();
      return;
    }

    const tokens = url.searchParams.getAll('token');
    if (tokens.length > 1) {
      socket.destroy();
      return;
    }
    const token = tokens[0] ?? undefined;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, lobbyId, token);
    });
  });

  wss.on('connection', (ws: WebSocket, _request: unknown, lobbyId: string, token?: string) => {
    const runtime = lobbyRuntimes.get(lobbyId);
    if (!runtime) {
      ws.close();
      return;
    }

    // Resolve power from token, verifying it belongs to this lobby
    let clientPower: Power | undefined;
    if (token) {
      const identity = lobbyManager.validateToken(token);
      if (identity && 'power' in identity && identity.lobbyId === lobbyId) {
        clientPower = identity.power;
      }
    }

    runtime.clients.set(ws, clientPower);
    logger.info(
      `Client connected to lobby ${lobbyId}${clientPower ? ` as ${clientPower}` : ' (spectator)'}`,
    );

    // Filter press messages in full_history per connection's auth level
    const filteredSnapshots = runtime.phaseSnapshots.map((s) => ({
      ...s,
      messages: s.messages.filter((msg) => {
        if (msg.to === 'Global') return true;
        if (!clientPower) return false;
        return (
          msg.to === clientPower ||
          msg.from === clientPower ||
          (Array.isArray(msg.to) && msg.to.includes(clientPower))
        );
      }),
    }));

    ws.send(
      JSON.stringify({
        type: 'full_history',
        snapshots: filteredSnapshots,
        gameId: runtime.gameId,
      }),
    );

    ws.on('close', () => {
      runtime.clients.delete(ws);
      logger.info(`Client disconnected from lobby ${lobbyId}`);
    });
  });

  server.listen(PORT, () => {
    logger.info(`Diplomacy game server running at http://localhost:${PORT}`);
    logger.info(`tRPC endpoint: http://localhost:${PORT}/trpc`);
    logger.info(`Database: ${DB_PATH}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    storage.close();
    process.exit(0);
  });
}

startServer();

export type AppRouter = ReturnType<
  typeof router<{
    describe: typeof describeProcedure;
    lobby: ReturnType<typeof createLobbyRouter>;
    game: ReturnType<typeof createGameRouter>;
  }>
>;
