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
});
