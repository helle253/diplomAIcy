import { describe, expect, it } from 'vitest';

import { PROVINCES } from '../engine/map.js';
import { Power, ProvinceType, UnitType } from '../engine/types.js';
import { LobbyManager } from './lobby-manager.js';
import { GameManager } from './manager.js';
import { createGameRouter } from './router.js';
import { createContext, router } from './trpc.js';

function setupTestGame() {
  const lm = new LobbyManager();
  const { lobbyId } = lm.createLobby({
    name: 'Wire Format Test',
    maxYears: 1,
    victoryThreshold: 18,
    startYear: 1901,
    phaseDelayMs: 0,
    remoteTimeoutMs: 0,
    pressDelayMin: 0,
    pressDelayMax: 0,
    agentConfig: { defaultAgent: { type: 'random' } },
  });

  // Manually attach a GameManager (skip agent wiring — we just need state)
  const lobby = lm.getLobby(lobbyId)!;
  lobby.manager = new GameManager({ maxYears: 1, phaseDelayMs: 0 });
  lobby.status = 'playing';

  const gameRouter = createGameRouter(lm);
  const appRouter = router({ game: gameRouter });
  const caller = appRouter.createCaller(createContext({ req: { headers: {} } }));

  return { caller, lobbyId };
}

describe('game router wire format', () => {
  describe('getState', () => {
    it('returns map field with all provinces', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      expect(state.map).toBeDefined();
      expect(Object.keys(state.map)).toHaveLength(Object.keys(PROVINCES).length);
    });

    it('does not return units or supplyCenters fields', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally checking old fields are gone
      const raw = state as Record<string, unknown>;
      expect(raw['units']).toBeUndefined();
      expect(raw['supplyCenters']).toBeUndefined();
    });

    it('includes province topology (type, adjacent, supplyCenter, homeCenter)', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      const mun = state.map['mun'];
      expect(mun.type).toBe(ProvinceType.Land);
      expect(mun.supplyCenter).toBe(true);
      expect(mun.homeCenter).toBe(Power.Germany);
      expect(mun.adjacent).toContain('bur');
      expect(mun.coasts).toBeNull();
    });

    it('includes coast data for multi-coast provinces', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      const spa = state.map['spa'];
      expect(spa.coasts).not.toBeNull();
      expect(spa.coasts!['nc']).toContain('mao');
      expect(spa.coasts!['sc']).toContain('lyo');
    });

    it('includes unit data on provinces', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      // Germany starts with Army in Munich
      const mun = state.map['mun'];
      expect(mun.unit).toEqual({
        type: UnitType.Army,
        power: Power.Germany,
        coast: null,
      });

      // Empty province has null unit
      expect(state.map['bur'].unit).toBeNull();
    });

    it('includes supply center ownership', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      expect(state.map['mun'].owner).toBe(Power.Germany);
      expect(state.map['bel'].owner).toBeNull();
    });

    it('includes phase, orderHistory, and other top-level fields', async () => {
      const { caller, lobbyId } = setupTestGame();
      const state = await caller.game.getState({ lobbyId });

      expect(state.phase).toBeDefined();
      expect(state.phase.year).toBe(1901);
      expect(state.orderHistory).toEqual([]);
      expect(state.retreatSituations).toEqual([]);
      expect(state.endYear).toBeDefined();
      expect(state.deadlineMs).toBeDefined();
      expect(state.gameOver).toBe(false);
    });
  });

  describe('getRules', () => {
    it('returns rules as markdown string with game config substituted', async () => {
      const { caller, lobbyId } = setupTestGame();
      const result = await caller.game.getRules({ lobbyId });

      expect(result.rules).toContain('# Diplomacy Rules');
      expect(result.rules).toContain('Hold');
      expect(result.rules).toContain('Move');
      expect(result.rules).toContain('Support');
      expect(result.rules).toContain('Build');
      // Config values should be substituted (maxYears=1, startYear=1901 → endYear=1901)
      expect(result.rules).toContain('1901');
      expect(result.rules).toContain('18 or more supply centers');
      // Template placeholders should be gone
      expect(result.rules).not.toContain('{{');
    });
  });

  describe('getSchemas', () => {
    it('returns JSON schemas for orders, retreats, and builds', async () => {
      const { caller } = setupTestGame();
      const result = await caller.game.getSchemas();

      expect(result.orders).toBeDefined();
      expect(result.retreats).toBeDefined();
      expect(result.builds).toBeDefined();

      // Orders schema should reference Hold, Move, Support, Convoy
      const ordersStr = JSON.stringify(result.orders);
      expect(ordersStr).toContain('Hold');
      expect(ordersStr).toContain('Move');
      expect(ordersStr).toContain('Support');
      expect(ordersStr).toContain('Convoy');

      // Builds schema should reference Build, Remove, Waive
      const buildsStr = JSON.stringify(result.builds);
      expect(buildsStr).toContain('Build');
      expect(buildsStr).toContain('Remove');
      expect(buildsStr).toContain('Waive');
      expect(buildsStr).toContain('unitType');
    });
  });
});
