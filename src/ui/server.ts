import 'dotenv/config';

import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { connectAgent } from '../agent/adapter.js';
import { AnthropicClient } from '../agent/llm/anthropic-client.js';
import { getAgentConfig, loadConfig, toLLMClientConfig } from '../agent/llm/config.js';
import { LLMAgent } from '../agent/llm/llm-agent.js';
import { LLMClient, OpenAICompatibleClient } from '../agent/llm/llm-client.js';
import { RandomAgent } from '../agent/random.js';
import { GameState, Message, Power } from '../engine/types.js';
import type { GameEvent, TurnRecord } from '../game/manager.js';
import { GameManager } from '../game/manager.js';
import { createGameRouter } from '../game/router.js';
import { GameStorage } from '../game/storage.js';
import { logger } from '../util/logger.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeState(state: GameState) {
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

let currentManager: GameManager | null = null;
let currentGameId: string | null = null;
let phaseSnapshots: PhaseSnapshot[] = [];
let allMessages: Message[] = [];

function broadcast(wss: WebSocketServer, data: unknown): void {
  const message = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

let gameRunning = false;
let startGameTrigger: (() => void) | null = null;

async function startGame(wss: WebSocketServer, storage: GameStorage): Promise<void> {
  const maxYears = parseInt(process.env.MAX_YEARS || '10');
  const phaseDelayMs = parseInt(process.env.PHASE_DELAY || '600000');
  const remoteTimeoutMs = parseInt(process.env.REMOTE_TIMEOUT || '0');
  const manager = new GameManager(maxYears, phaseDelayMs, remoteTimeoutMs);
  currentManager = manager;
  phaseSnapshots = [];
  allMessages = [];
  gameRunning = true;

  // Create game record in SQLite
  const gameId = storage.createGame();
  currentGameId = gameId;

  // Create and connect agents
  const gameConfig = loadConfig();
  for (const power of ALL_POWERS) {
    const agentCfg = getAgentConfig(gameConfig, power);
    if (agentCfg.type === 'remote') {
      logger.info(`  ${power}: Remote (waiting for connection)`);
      continue;
    }
    let agent;
    if (agentCfg.type === 'llm') {
      const clientConfig = toLLMClientConfig(agentCfg);
      const client: LLMClient =
        agentCfg.provider === 'anthropic'
          ? new AnthropicClient(clientConfig)
          : new OpenAICompatibleClient(clientConfig);
      agent = new LLMAgent(power, client);
      logger.info(`  ${power}: LLM (${agentCfg.provider ?? 'openai'} / ${clientConfig.model})`);
    } else {
      agent = new RandomAgent(power);
      logger.info(`  ${power}: Random`);
    }

    // Initialize and connect via adapter
    await agent.initialize(manager.getState());
    connectAgent(agent, manager);
  }

  // Persist and broadcast messages in real-time
  manager.onMessage((message: Message) => {
    message.gameId = gameId;
    storage.saveMessage(gameId, message);
    allMessages.push(message);
    broadcast(wss, { type: 'message', message });
  });

  manager.onEvent((event: GameEvent) => {
    // Persist turn records
    if (event.turnRecord) {
      storage.saveTurnRecord(gameId, event.turnRecord);
    }

    const snapshot: PhaseSnapshot = {
      phase: event.phase,
      gameState: serializeState(event.gameState),
      turnRecord: event.turnRecord,
      messages: [...allMessages],
    };
    phaseSnapshots.push(snapshot);

    broadcast(wss, {
      type: 'new_phase',
      snapshotIndex: phaseSnapshots.length - 1,
      snapshot,
    });
  });

  logger.info(`Starting new Diplomacy game (${gameId})...`);

  try {
    const result = await manager.run();
    storage.completeGame(gameId, result);
    broadcast(wss, {
      type: 'game_end',
      result: {
        ...result,
        supplyCenters: Object.fromEntries(result.supplyCenters),
      },
    });
    logger.info(
      result.winner
        ? `Game over! ${result.winner} wins in ${result.year}.`
        : `Game ended in a draw in year ${result.year}.`,
    );
  } catch (err) {
    storage.failGame(gameId);
    logger.error('Game error:', err);
  }

  gameRunning = false;
  broadcast(wss, { type: 'game_waiting' });
  logger.info('Game finished. Waiting for new game request...');
}

async function runGameLoop(wss: WebSocketServer, storage: GameStorage): Promise<void> {
  // Auto-start the first game
  await startGame(wss, storage);

  // Then wait for manual triggers
  while (true) {
    await new Promise<void>((resolve) => {
      startGameTrigger = resolve;
    });
    startGameTrigger = null;
    await startGame(wss, storage);
  }
}

function startServer(): void {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const storage = new GameStorage(DB_PATH);

  // Serve static files from Vite build output
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));

  // REST endpoints
  app.get('/api/state', (_req, res) => {
    if (currentManager) {
      res.json(serializeState(currentManager.getState()));
    } else {
      res.status(503).json({ error: 'No game in progress' });
    }
  });

  app.get('/api/snapshots', (_req, res) => {
    res.json(phaseSnapshots);
  });

  app.get('/api/games', (_req, res) => {
    const games = storage.listGames();
    res.json({
      liveGameId: currentGameId,
      games,
    });
  });

  app.get('/api/games/:id/messages', (req, res) => {
    const power = req.query.power as Power | undefined;
    const messages = storage.getMessages(req.params.id, { power });
    res.json(messages);
  });

  app.get('/api/games/:id/turns', (req, res) => {
    const turns = storage.getTurnRecords(req.params.id);
    res.json(turns);
  });

  app.post('/api/new-game', (_req, res) => {
    if (gameRunning) {
      res.status(409).json({ error: 'A game is already in progress' });
      return;
    }
    if (startGameTrigger) {
      startGameTrigger();
      res.json({ status: 'starting' });
    } else {
      res.status(503).json({ error: 'Server not ready' });
    }
  });

  // Mount tRPC router (lazily bound to current game manager)
  app.use(
    '/trpc',
    (req, res, next) => {
      if (!currentManager) {
        res.status(503).json({ error: 'No game in progress' });
        return;
      }
      const gameRouter = createGameRouter(currentManager);
      createExpressMiddleware({ router: gameRouter })(req, res, next);
    },
  );

  // WebSocket connection handler
  wss.on('connection', (ws: WebSocket) => {
    logger.info('Client connected');

    // Send all accumulated snapshots on connect so client can build slider
    ws.send(
      JSON.stringify({
        type: 'full_history',
        snapshots: phaseSnapshots,
        gameId: currentGameId,
      }),
    );

    ws.on('close', () => {
      logger.info('Client disconnected');
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

  // Start game loop (runs in background)
  runGameLoop(wss, storage);
}

startServer();
