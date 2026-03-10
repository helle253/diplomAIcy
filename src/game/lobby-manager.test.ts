import { describe, expect, it, vi } from 'vitest';

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
    const id = lm.createLobby(DEFAULT_CONFIG);
    const lobby = lm.getLobby(id);

    expect(lobby).toBeDefined();
    expect(lobby!.status).toBe('waiting');
    expect(lobby!.config).toEqual(DEFAULT_CONFIG);
    expect(lobby!.manager).toBeNull();
    expect(lobby!.id).toBe(id);
    expect(typeof lobby!.createdAt).toBe('number');
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
    const id = lm.createLobby(DEFAULT_CONFIG);
    lm.deleteLobby(id);
    expect(lm.getLobby(id)).toBeUndefined();
  });

  it('deleteLobby throws for non-existent lobby', () => {
    const lm = new LobbyManager();
    expect(() => lm.deleteLobby('nonexistent')).toThrow('not found');
  });

  it('deleteLobby throws for playing lobby', async () => {
    const lm = new LobbyManager();
    const id = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    expect(() => lm.deleteLobby(id)).toThrow('Cannot delete a playing lobby');
  });

  it('deleteLobby works for finished lobby and calls bus.destroy()', async () => {
    const lm = new LobbyManager();
    const id = lm.createLobby(DEFAULT_CONFIG);
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
    const id = lm.createLobby(config);
    const manager = await lm.startLobby(id);

    expect(manager).toBeInstanceOf(GameManager);
    const state = manager.getState();
    expect(state.phase.year).toBe(1905);
  });

  it('startLobby changes status to playing', async () => {
    const lm = new LobbyManager();
    const id = lm.createLobby(DEFAULT_CONFIG);
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
    const id = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    await expect(lm.startLobby(id)).rejects.toThrow('playing, not waiting');
  });

  it('startLobby calls onStart handler', async () => {
    const lm = new LobbyManager();
    const handler = vi.fn();
    lm.onStart(handler);

    const id = lm.createLobby(DEFAULT_CONFIG);
    const manager = await lm.startLobby(id);

    expect(handler).toHaveBeenCalledWith(id, manager);
  });

  it('finishLobby changes status to finished', async () => {
    const lm = new LobbyManager();
    const id = lm.createLobby(DEFAULT_CONFIG);
    await lm.startLobby(id);
    lm.finishLobby(id);

    const lobby = lm.getLobby(id);
    expect(lobby!.status).toBe('finished');
  });
});
