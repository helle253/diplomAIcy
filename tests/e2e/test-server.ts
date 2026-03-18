/**
 * Lightweight test server for Playwright screenshot tests.
 * Serves the built UI static files and injects controlled game state via WebSocket.
 */
import express from 'express';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { buildMapState } from '../../src/engine/map-state.js';
import type { Power, Unit } from '../../src/engine/types.js';

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
    map: Record<string, unknown>;
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
  phase = { year: 1901, season: 'Spring', type: 'Orders' },
  turnRecord?: unknown,
): TestSnapshot {
  const engineUnits: Unit[] = units.map((u) => ({
    type: u.type as Unit['type'],
    power: u.power as Power,
    province: u.province,
    ...(u.coast ? { coast: u.coast as Unit['coast'] } : {}),
  }));
  const scMap = new Map<string, Power>(
    Object.entries(supplyCenters).map(([k, v]) => [k, v as Power]),
  );
  const map = buildMapState(engineUnits, scMap);
  return {
    phase,
    gameState: { phase, map, retreatSituations: [] },
    turnRecord,
    messages: [],
  };
}

// --- Order / arrow test helpers ------------------------------------------------

export interface TestOrderResolution {
  order: {
    type: string;
    unit: string;
    destination?: string;
    coast?: string;
    supportedUnit?: string;
    viaConvoy?: boolean;
  };
  power: string;
  status: 'Succeeds' | 'Fails' | 'Invalid';
  reason?: string;
}

export function makeMove(
  power: string,
  unit: string,
  destination: string,
  status: 'Succeeds' | 'Fails' = 'Succeeds',
  coast?: string,
): TestOrderResolution {
  return {
    order: { type: 'Move', unit, destination, ...(coast ? { coast } : {}) },
    power,
    status,
  };
}

export function makeSupport(
  power: string,
  unit: string,
  supportedUnit: string,
  destination: string | undefined,
  status: 'Succeeds' | 'Fails' = 'Succeeds',
): TestOrderResolution {
  return {
    order: {
      type: 'Support',
      unit,
      supportedUnit,
      ...(destination ? { destination } : {}),
    },
    power,
    status,
  };
}

export function makeHold(power: string, unit: string): TestOrderResolution {
  return { order: { type: 'Hold', unit }, power, status: 'Succeeds' };
}

/** Build an Orders-phase snapshot with a turnRecord containing order resolutions. */
export function makeOrdersSnapshot(
  units: TestUnit[],
  orders: TestOrderResolution[],
  supplyCenters: Record<string, string> = STARTING_SC,
  phase = { year: 1901, season: 'Spring', type: 'Orders' },
): TestSnapshot {
  return makeSnapshot(units, supplyCenters, phase, { orders });
}

export interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** Send a new snapshot to all connected clients */
  setSnapshot: (snapshot: TestSnapshot) => void;
  /** Send multiple snapshots (full timeline) to all connected clients */
  setSnapshots: (snapshots: TestSnapshot[]) => void;
}

export async function startTestServer(snapshots: TestSnapshot[]): Promise<TestServer> {
  const app = express();
  app.use(express.static(PUBLIC_DIR));

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Accept WebSocket upgrades at /ws/:lobbyId (any lobbyId)
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', 'http://localhost');
    if (pathname?.startsWith('/ws/')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws);
      });
    } else {
      socket.destroy();
    }
  });

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
    setSnapshots([snapshot]);
  }

  function setSnapshots(snaps: TestSnapshot[]) {
    currentSnapshots = [...snaps];
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
        url: `http://localhost:${port}#/game/test`,
        port,
        setSnapshot,
        setSnapshots,
        close: () =>
          new Promise<void>((res) => {
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
