import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GameManager } from '../game/manager.js';
import { RandomAgent } from '../agent/random.js';
import { Power, GameState, Message } from '../engine/types.js';
import type { GameEvent, TurnRecord } from '../game/manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000');
const RESTART_DELAY_MS = parseInt(process.env.RESTART_DELAY || '5000');

const ALL_POWERS: Power[] = [
  Power.England, Power.France, Power.Germany, Power.Italy,
  Power.Austria, Power.Russia, Power.Turkey,
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

async function runGameLoop(wss: WebSocketServer): Promise<void> {
  while (true) {
    const maxYears = parseInt(process.env.MAX_YEARS || '10');
    const manager = new GameManager(maxYears);
    currentManager = manager;
    phaseSnapshots = [];
    allMessages = [];

    for (const power of ALL_POWERS) {
      manager.registerAgent(new RandomAgent(power));
    }

    manager.onEvent((event: GameEvent) => {
      // Collect messages from diplomacy turn records
      if (event.turnRecord?.messages) {
        allMessages.push(...event.turnRecord.messages);
      }

      const snapshot: PhaseSnapshot = {
        phase: event.phase,
        gameState: serializeState(event.gameState),
        turnRecord: event.turnRecord,
        messages: [...allMessages],
      };
      phaseSnapshots.push(snapshot);

      // Broadcast the new snapshot index and data
      broadcast(wss, {
        type: 'new_phase',
        snapshotIndex: phaseSnapshots.length - 1,
        snapshot,
      });
    });

    console.log('Starting new Diplomacy game...');

    try {
      const result = await manager.run();
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
          : `Game ended in a draw in year ${result.year}.`
      );
    } catch (err) {
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
  const wss = new WebSocketServer({ server });

  // Serve static files from public directory
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

  // WebSocket connection handler
  wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected');

    // Send all accumulated snapshots on connect so client can build slider
    ws.send(JSON.stringify({
      type: 'full_history',
      snapshots: phaseSnapshots,
    }));

    ws.on('close', () => {
      console.log('Client disconnected');
    });
  });

  server.listen(PORT, () => {
    console.log(`Diplomacy game server running at http://localhost:${PORT}`);
  });

  // Start game loop (runs in background)
  runGameLoop(wss);
}

startServer();
