/**
 * Lightweight test server for Playwright screenshot tests.
 * Serves the built UI static files and injects controlled game state via WebSocket.
 */
import express from 'express';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '../../dist/ui/public');

export interface TestUnit {
  type: 'Army' | 'Fleet';
  power: string;
  province: string;
  coast?: string;
}

export interface TestSnapshot {
  phase: { year: number; season: string; type: string };
  gameState: {
    phase: { year: number; season: string; type: string };
    units: TestUnit[];
    supplyCenters: Record<string, string>;
    retreatSituations: unknown[];
  };
  turnRecord?: unknown;
  messages: unknown[];
}

/** Standard Diplomacy starting positions (Spring 1901). */
export const STARTING_UNITS: TestUnit[] = [
  // England
  { type: 'Fleet', power: 'England', province: 'lon' },
  { type: 'Fleet', power: 'England', province: 'edi' },
  { type: 'Army', power: 'England', province: 'lvp' },
  // France
  { type: 'Fleet', power: 'France', province: 'bre' },
  { type: 'Army', power: 'France', province: 'par' },
  { type: 'Army', power: 'France', province: 'mar' },
  // Germany
  { type: 'Fleet', power: 'Germany', province: 'kie' },
  { type: 'Army', power: 'Germany', province: 'ber' },
  { type: 'Army', power: 'Germany', province: 'mun' },
  // Italy
  { type: 'Fleet', power: 'Italy', province: 'nap' },
  { type: 'Army', power: 'Italy', province: 'rom' },
  { type: 'Army', power: 'Italy', province: 'ven' },
  // Austria
  { type: 'Fleet', power: 'Austria', province: 'tri' },
  { type: 'Army', power: 'Austria', province: 'vie' },
  { type: 'Army', power: 'Austria', province: 'bud' },
  // Russia
  { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
  { type: 'Fleet', power: 'Russia', province: 'sev' },
  { type: 'Army', power: 'Russia', province: 'mos' },
  { type: 'Army', power: 'Russia', province: 'war' },
  // Turkey
  { type: 'Fleet', power: 'Turkey', province: 'ank' },
  { type: 'Army', power: 'Turkey', province: 'con' },
  { type: 'Army', power: 'Turkey', province: 'smy' },
];

/** Starting supply center ownership. */
export const STARTING_SC: Record<string, string> = {
  lon: 'England',
  edi: 'England',
  lvp: 'England',
  bre: 'France',
  par: 'France',
  mar: 'France',
  kie: 'Germany',
  ber: 'Germany',
  mun: 'Germany',
  nap: 'Italy',
  rom: 'Italy',
  ven: 'Italy',
  tri: 'Austria',
  vie: 'Austria',
  bud: 'Austria',
  stp: 'Russia',
  sev: 'Russia',
  mos: 'Russia',
  war: 'Russia',
  ank: 'Turkey',
  con: 'Turkey',
  smy: 'Turkey',
};

export function makeSnapshot(
  units: TestUnit[],
  supplyCenters: Record<string, string> = STARTING_SC,
  phase = { year: 1901, season: 'Spring', type: 'Diplomacy' },
): TestSnapshot {
  return {
    phase,
    gameState: { phase, units, supplyCenters, retreatSituations: [] },
    messages: [],
  };
}

export interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** Send a new snapshot to all connected clients */
  setSnapshot: (snapshot: TestSnapshot) => void;
}

export async function startTestServer(snapshots: TestSnapshot[]): Promise<TestServer> {
  const app = express();
  app.use(express.static(PUBLIC_DIR));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  let currentSnapshots = [...snapshots];

  wss.on('connection', (ws: WebSocket) => {
    ws.send(
      JSON.stringify({
        type: 'full_history',
        snapshots: currentSnapshots,
        gameId: 'test-game',
      }),
    );
  });

  function setSnapshot(snapshot: TestSnapshot) {
    currentSnapshots = [snapshot];
    const msg = JSON.stringify({
      type: 'full_history',
      snapshots: currentSnapshots,
      gameId: 'test-game',
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://localhost:${port}`,
        port,
        setSnapshot,
        close: () =>
          new Promise<void>((res) => {
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
