import express from 'express';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { RandomAgent } from '../agent/random.js';
import { GameState, Message, Power } from '../engine/types.js';
import type { GameEvent, TurnRecord } from '../game/manager.js';
import { GameManager } from '../game/manager.js';
import { GameStorage } from '../game/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000');
const RESTART_DELAY_MS = parseInt(process.env.RESTART_DELAY || '5000');
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

async function runGameLoop(wss: WebSocketServer, storage: GameStorage): Promise<void> {
  while (true) {
    const maxYears = parseInt(process.env.MAX_YEARS || '10');
    const phaseDelayMs = parseInt(process.env.PHASE_DELAY || '60000');
    const manager = new GameManager(maxYears, phaseDelayMs);
    currentManager = manager;
    phaseSnapshots = [];
    allMessages = [];

    // Create game record in SQLite
    const gameId = storage.createGame();
    currentGameId = gameId;

    for (const power of ALL_POWERS) {
      manager.registerAgent(new RandomAgent(power));
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

    console.log(`Starting new Diplomacy game (${gameId})...`);

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
      console.log(
        result.winner
          ? `Game over! ${result.winner} wins in ${result.year}.`
          : `Game ended in a draw in year ${result.year}.`,
      );
    } catch (err) {
      storage.failGame(gameId);
      console.error('Game error:', err);
    }

    console.log(`Next game starts in ${RESTART_DELAY_MS / 1000} seconds...`);
    broadcast(wss, { type: 'game_restarting', delayMs: RESTART_DELAY_MS });
    await sleep(RESTART_DELAY_MS);
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

  // WebSocket connection handler
  wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected');

    // Send all accumulated snapshots on connect so client can build slider
    ws.send(
      JSON.stringify({
        type: 'full_history',
        snapshots: phaseSnapshots,
        gameId: currentGameId,
      }),
    );

    ws.on('close', () => {
      console.log('Client disconnected');
    });
  });

  server.listen(PORT, () => {
    console.log(`Diplomacy game server running at http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    storage.close();
    process.exit(0);
  });

  // Start game loop (runs in background)
  runGameLoop(wss, storage);
}

startServer();
