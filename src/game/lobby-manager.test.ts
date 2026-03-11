import { describe, expect, it, vi } from 'vitest';

import { Power } from '../engine/types.js';
import { LobbyConfig, LobbyManager } from './lobby-manager.js';
import { GameManager } from './manager.js';

const DEFAULT_CONFIG: LobbyConfig = {
  name: 'Test Game',
  maxYears: 50,
  victoryThreshold: 18,
  startYear: 1901,
  phaseDelayMs: 0,
  remoteTimeoutMs: 0,
  pressDelayMin: 0,
  pressDelayMax: 0,
  agentConfig: { defaultAgent: { type: 'random' } },
};

describe('LobbyManager', () => {
  it('createLobby creates a waiting lobby with correct config', () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    const lobby = lm.getLobby(id);

    expect(lobby).toBeDefined();
    expect(lobby!.status).toBe('waiting');
    expect(lobby!.config).toEqual(DEFAULT_CONFIG);
    expect(lobby!.manager).toBeNull();
    expect(lobby!.id).toBe(id);
    expect(typeof lobby!.createdAt).toBe('number');
  });

  it('createLobby returns lobbyId and creatorToken', () => {
    const lm = new LobbyManager();
    const result = lm.createLobby(DEFAULT_CONFIG);
    expect(result).toHaveProperty('lobbyId');
    expect(result).toHaveProperty('creatorToken');
    expect(typeof result.lobbyId).toBe('string');
    expect(typeof result.creatorToken).toBe('string');
    expect(result.creatorToken.length).toBeGreaterThan(0);
  });

  it('listLobbies returns all lobbies', () => {
    const lm = new LobbyManager();
    lm.createLobby(DEFAULT_CONFIG);
    lm.createLobby({ ...DEFAULT_CONFIG, name: 'Game 2' });

    const lobbies = lm.listLobbies();
    expect(lobbies).toHaveLength(2);
  });

  it('getLobby returns undefined for unknown id', () => {
    const lm = new LobbyManager();
    expect(lm.getLobby('nonexistent')).toBeUndefined();
  });

  it('deleteLobby removes a waiting lobby', () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    lm.deleteLobby(id);
    expect(lm.getLobby(id)).toBeUndefined();
  });

  it('deleteLobby throws for non-existent lobby', () => {
    const lm = new LobbyManager();
    expect(() => lm.deleteLobby('nonexistent')).toThrow('not found');
  });

  it('deleteLobby throws for playing lobby', async () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    expect(() => lm.deleteLobby(id)).toThrow('Cannot delete a playing lobby');
  });

  it('deleteLobby works for finished lobby and calls bus.destroy()', async () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    const manager = await lm.startLobby(id);
    const destroySpy = vi.spyOn(manager.bus, 'destroy');

    lm.finishLobby(id);
    lm.deleteLobby(id);

    expect(destroySpy).toHaveBeenCalled();
    expect(lm.getLobby(id)).toBeUndefined();
  });

  it('startLobby creates a GameManager with correct config', async () => {
    const lm = new LobbyManager();
    const config: LobbyConfig = {
      ...DEFAULT_CONFIG,
      maxYears: 10,
      victoryThreshold: 12,
      startYear: 1905,
    };
    const { lobbyId: id } = lm.createLobby(config);
    const manager = await lm.startLobby(id);

    expect(manager).toBeInstanceOf(GameManager);
    const state = manager.getState();
    expect(state.phase.year).toBe(1905);
  });

  it('startLobby changes status to playing', async () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);

    const lobby = lm.getLobby(id);
    expect(lobby!.status).toBe('playing');
  });

  it('startLobby throws for non-existent lobby', async () => {
    const lm = new LobbyManager();
    await expect(lm.startLobby('nonexistent')).rejects.toThrow('not found');
  });

  it('startLobby throws for already-playing lobby', async () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    await expect(lm.startLobby(id)).rejects.toThrow('playing, not waiting');
  });

  it('startLobby sets status to starting during _onStart, preventing concurrent starts', async () => {
    const lm = new LobbyManager();
    let statusDuringStart: string | undefined;
    lm.onStart(async (id) => {
      statusDuringStart = lm.getLobby(id)!.status;
    });
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    expect(statusDuringStart).toBe('starting');
    expect(lm.getLobby(id)!.status).toBe('playing');
  });

  it('startLobby rolls back status on _onStart failure', async () => {
    const lm = new LobbyManager();
    lm.onStart(async () => {
      throw new Error('startup failed');
    });
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    await expect(lm.startLobby(id)).rejects.toThrow('startup failed');
    const lobby = lm.getLobby(id)!;
    expect(lobby.status).toBe('waiting');
    expect(lobby.manager).toBeNull();
  });

  it('startLobby rejects concurrent calls with starting guard', async () => {
    const lm = new LobbyManager();
    let resolveStart: (() => void) | null = null;
    lm.onStart(async () => {
      await new Promise<void>((r) => {
        resolveStart = r;
      });
    });
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    const p1 = lm.startLobby(id);
    // Second call should fail immediately since status is 'starting'
    await expect(lm.startLobby(id)).rejects.toThrow('starting, not waiting');
    resolveStart!();
    await p1;
    expect(lm.getLobby(id)!.status).toBe('playing');
  });

  it('startLobby calls onStart handler', async () => {
    const lm = new LobbyManager();
    const handler = vi.fn();
    lm.onStart(handler);

    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    const manager = await lm.startLobby(id);

    expect(handler).toHaveBeenCalledWith(id, manager);
  });

  it('finishLobby changes status to finished', async () => {
    const lm = new LobbyManager();
    const { lobbyId: id } = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    lm.finishLobby(id);

    const lobby = lm.getLobby(id);
    expect(lobby!.status).toBe('finished');
  });

  describe('joinLobby', () => {
    it('returns a seatToken for a valid join', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const result = lm.joinLobby(lobbyId, Power.England);
      expect(result).toHaveProperty('seatToken');
      expect(typeof result.seatToken).toBe('string');
    });

    it('records the seat in the lobby', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      lm.joinLobby(lobbyId, Power.England);
      const lobby = lm.getLobby(lobbyId)!;
      expect(lobby.seats.has(Power.England)).toBe(true);
    });

    it('throws if power already claimed', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      lm.joinLobby(lobbyId, Power.England);
      expect(() => lm.joinLobby(lobbyId, Power.England)).toThrow('already claimed');
    });

    it('throws if lobby not found', () => {
      const lm = new LobbyManager();
      expect(() => lm.joinLobby('nope', Power.England)).toThrow('not found');
    });

    it('throws if lobby is not waiting', async () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      await lm.startLobby(lobbyId);
      expect(() => lm.joinLobby(lobbyId, Power.England)).toThrow('not accepting players');
    });
  });

  describe('autostart', () => {
    const ALL_POWERS: Power[] = [
      Power.England,
      Power.France,
      Power.Germany,
      Power.Italy,
      Power.Austria,
      Power.Russia,
      Power.Turkey,
    ];

    it('triggers startLobby when last seat is filled and autostart is true', async () => {
      const lm = new LobbyManager();
      const handler = vi.fn();
      lm.onStart(handler);
      const { lobbyId } = lm.createLobby({ ...DEFAULT_CONFIG, autostart: true });
      for (const power of ALL_POWERS) {
        lm.joinLobby(lobbyId, power);
      }
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      const lobby = lm.getLobby(lobbyId)!;
      expect(lobby.status).toBe('playing');
    });

    it('does not autostart when autostart is false', () => {
      const lm = new LobbyManager();
      const handler = vi.fn();
      lm.onStart(handler);
      const { lobbyId } = lm.createLobby({ ...DEFAULT_CONFIG, autostart: false });
      for (const power of ALL_POWERS) {
        lm.joinLobby(lobbyId, power);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(lm.getLobby(lobbyId)!.status).toBe('waiting');
    });

    it('does not autostart when not all seats are filled', () => {
      const lm = new LobbyManager();
      const handler = vi.fn();
      lm.onStart(handler);
      const { lobbyId } = lm.createLobby({ ...DEFAULT_CONFIG, autostart: true });
      lm.joinLobby(lobbyId, Power.England);
      lm.joinLobby(lobbyId, Power.France);
      expect(handler).not.toHaveBeenCalled();
      expect(lm.getLobby(lobbyId)!.status).toBe('waiting');
    });
  });

  describe('kickPlayer', () => {
    it('removes a seat from a waiting lobby', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      lm.joinLobby(lobbyId, Power.England);
      lm.kickPlayer(lobbyId, Power.England);
      expect(lm.getLobby(lobbyId)!.seats.has(Power.England)).toBe(false);
    });

    it('throws if lobby is not waiting', async () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      lm.joinLobby(lobbyId, Power.England);
      await lm.startLobby(lobbyId);
      expect(() => lm.kickPlayer(lobbyId, Power.England)).toThrow('waiting status');
    });

    it('throws if power has no seat', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      expect(() => lm.kickPlayer(lobbyId, Power.England)).toThrow('has no seat');
    });
  });

  describe('rejoinLobby', () => {
    it('issues a new seatToken when given the correct old token', async () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const { seatToken: oldToken } = lm.joinLobby(lobbyId, Power.England);
      await lm.startLobby(lobbyId);
      const { seatToken: newToken } = lm.rejoinLobby(lobbyId, Power.England, oldToken);
      expect(newToken).not.toBe(oldToken);
      expect(typeof newToken).toBe('string');
    });

    it('throws if old token does not match', async () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      lm.joinLobby(lobbyId, Power.England);
      await lm.startLobby(lobbyId);
      expect(() => lm.rejoinLobby(lobbyId, Power.England, 'wrong-token')).toThrow('Invalid token');
    });

    it('throws if lobby is not playing', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const { seatToken } = lm.joinLobby(lobbyId, Power.England);
      expect(() => lm.rejoinLobby(lobbyId, Power.England, seatToken)).toThrow('not playing');
    });

    it('invalidates the old token after rejoin', async () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const { seatToken: oldToken } = lm.joinLobby(lobbyId, Power.England);
      await lm.startLobby(lobbyId);
      lm.rejoinLobby(lobbyId, Power.England, oldToken);
      expect(lm.validateToken(oldToken)).toBeNull();
    });
  });

  describe('validateToken', () => {
    it('resolves a seat token to lobbyId and power', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const { seatToken } = lm.joinLobby(lobbyId, Power.France);
      const result = lm.validateToken(seatToken);
      expect(result).toEqual({ lobbyId, power: Power.France });
    });

    it('resolves a creator token to lobbyId and role', () => {
      const lm = new LobbyManager();
      const { lobbyId, creatorToken } = lm.createLobby(DEFAULT_CONFIG);
      const result = lm.validateToken(creatorToken);
      expect(result).toEqual({ lobbyId, role: 'creator' });
    });

    it('returns null for an invalid token', () => {
      const lm = new LobbyManager();
      lm.createLobby(DEFAULT_CONFIG);
      expect(lm.validateToken('bad-token')).toBeNull();
    });

    it('returns null for a kicked player token', () => {
      const lm = new LobbyManager();
      const { lobbyId } = lm.createLobby(DEFAULT_CONFIG);
      const { seatToken } = lm.joinLobby(lobbyId, Power.England);
      lm.kickPlayer(lobbyId, Power.England);
      expect(lm.validateToken(seatToken)).toBeNull();
    });
  });
});
