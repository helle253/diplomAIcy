import { describe, expect, it } from 'vitest';

import type { LobbyConfig } from './lobby-manager.js';
import { LobbyManager } from './lobby-manager.js';
import { createLobbyRouter, type LobbyDefaults } from './lobby-router.js';
import { createContext, router } from './trpc.js';

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
};

const DEFAULTS: LobbyDefaults = {
  maxYears: 10,
  phaseDelayMs: 0,
  remoteTimeoutMs: 0,
  pressDelayMin: 0,
  pressDelayMax: 0,
  agentConfig: { defaultAgent: { type: 'random' } },
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
});
