import { unlinkSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LobbyConfig } from './lobby-manager';
import { LobbyManager } from './lobby-manager';
import { createLobbyRouter, type LobbyDefaults } from './lobby-router';
import { GameStorage } from './storage';
import { createContext, router } from './trpc';

const DEFAULT_CONFIG: LobbyConfig = {
  name: 'Test Game',
  maxYears: 50,
  victoryThreshold: 18,
  startYear: 1901,
  phaseDelayMs: 0,
  remoteTimeoutMs: 0,
  pressDelayMin: 0,
  pressDelayMax: 0,
  agentConfig: {
    defaultAgent: { type: 'llm', provider: 'openai', apiKey: 'sk-secret-key-123', model: 'gpt-4' },
    powers: {
      England: { type: 'llm', apiKey: 'sk-england-secret' },
    },
  },
  allowDraws: true,
};

const DEFAULTS: LobbyDefaults = {
  maxYears: 10,
  phaseDelayMs: 0,
  remoteTimeoutMs: 0,
  pressDelayMin: 0,
  pressDelayMax: 0,
  agentConfig: { defaultAgent: { type: 'random' } },
  fastAdjudication: true,
};

function createCaller(lobbyManager: LobbyManager) {
  const lobbyRouter = createLobbyRouter(lobbyManager, DEFAULTS);
  const appRouter = router({ lobby: lobbyRouter });

  // Direct caller for testing
  return appRouter.createCaller(createContext({ req: { headers: {} } }));
}

describe('lobby-router', () => {
  describe('get', () => {
    it('returns lobby details without leaking apiKey', async () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const caller = createCaller(lm);

      const result = await caller.lobby.get({ id: lobbyId });

      expect(result.id).toBe(lobbyId);
      expect(result.config.agentConfig.defaultAgent.apiKey).toBeUndefined();
      expect(result.config.agentConfig.powers?.England?.apiKey).toBeUndefined();
      // Non-secret fields should still be present
      expect(result.config.agentConfig.defaultAgent.model).toBe('gpt-4');
      expect(result.config.agentConfig.defaultAgent.type).toBe('llm');
    });

    it('throws TRPCError NOT_FOUND for unknown lobby', async () => {
      const lm = new LobbyManager();
      const caller = createCaller(lm);

      await expect(caller.lobby.get({ id: 'nonexistent' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('create with promptAssignments', () => {
    const TEST_DB = 'test-lobby-router-' + process.pid + '.db';
    let storage: GameStorage;

    beforeEach(() => {
      storage = new GameStorage(TEST_DB);
    });

    afterEach(() => {
      storage.close();
      try {
        unlinkSync(TEST_DB);
      } catch {}
      try {
        unlinkSync(TEST_DB + '-wal');
      } catch {}
      try {
        unlinkSync(TEST_DB + '-shm');
      } catch {}
    });

    function createCallerWithStorage(lobbyManager: LobbyManager) {
      const lobbyRouter = createLobbyRouter(lobbyManager, DEFAULTS, storage);
      const appRouter = router({ lobby: lobbyRouter });
      return appRouter.createCaller(createContext({ req: { headers: {} } }));
    }

    it('rejects lobby creation with non-existent promptId', async () => {
      const lm = new LobbyManager();
      const caller = createCallerWithStorage(lm);

      await expect(
        caller.lobby.create({
          name: 'Test',
          promptAssignments: {
            England: { promptId: 'nonexistent-id' },
          },
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('accepts lobby creation with valid promptId', async () => {
      const lm = new LobbyManager();
      const caller = createCallerWithStorage(lm);
      const { promptId } = storage.createPrompt('Test Prompt', 'Be aggressive', 'public');

      const result = await caller.lobby.create({
        name: 'Test',
        promptAssignments: {
          England: { promptId },
        },
      });

      expect(result.lobbyId).toBeDefined();
    });
  });
});
