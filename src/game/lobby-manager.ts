import { randomUUID } from 'crypto';

import type { GameConfig } from '../agent/llm/config.js';
import { GameManager } from './manager.js';

export interface LobbyConfig {
  name: string;
  maxYears: number;
  victoryThreshold: number;
  startYear: number;
  phaseDelayMs: number;
  remoteTimeoutMs: number;
  pressDelayMin: number;
  pressDelayMax: number;
  agentConfig: GameConfig;
}

export interface Lobby {
  id: string;
  config: LobbyConfig;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
  manager: GameManager | null;
}

export class LobbyManager {
  private lobbies = new Map<string, Lobby>();

  /** Called when a lobby is started — allows server.ts to wire agents and events. */
  private _onStart: ((id: string, manager: GameManager) => void | Promise<void>) | null = null;

  onStart(handler: (id: string, manager: GameManager) => void | Promise<void>): void {
    this._onStart = handler;
  }

  createLobby(config: LobbyConfig): string {
    const id = randomUUID().slice(0, 8);
    const lobby: Lobby = {
      id,
      config,
      status: 'waiting',
      createdAt: Date.now(),
      manager: null,
    };
    this.lobbies.set(id, lobby);
    return id;
  }

  getLobby(id: string): Lobby | undefined {
    return this.lobbies.get(id);
  }

  listLobbies(): Lobby[] {
    return Array.from(this.lobbies.values());
  }

  async startLobby(id: string): Promise<GameManager> {
    const lobby = this.lobbies.get(id);
    if (!lobby) throw new Error(`Lobby ${id} not found`);
    if (lobby.status !== 'waiting') throw new Error(`Lobby ${id} is ${lobby.status}, not waiting`);

    const config = lobby.config;
    const manager = new GameManager({
      maxYears: config.maxYears,
      victoryThreshold: config.victoryThreshold,
      startYear: config.startYear,
      phaseDelayMs: config.phaseDelayMs,
      remoteTimeoutMs: config.remoteTimeoutMs,
      pressDelayMin: config.pressDelayMin,
      pressDelayMax: config.pressDelayMax,
    });

    lobby.manager = manager;
    lobby.status = 'playing';

    // Notify server to wire agents and start the game loop
    if (this._onStart) await this._onStart(id, manager);

    return manager;
  }

  finishLobby(id: string): void {
    const lobby = this.lobbies.get(id);
    if (!lobby) return;
    lobby.status = 'finished';
  }

  deleteLobby(id: string): void {
    const lobby = this.lobbies.get(id);
    if (!lobby) throw new Error(`Lobby ${id} not found`);
    if (lobby.status === 'playing') throw new Error(`Cannot delete a playing lobby`);
    if (lobby.manager) {
      lobby.manager.bus.destroy();
    }
    this.lobbies.delete(id);
  }
}
