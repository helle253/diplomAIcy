import { randomUUID } from 'crypto';

import type { GameConfig } from '../agent/llm/config';
import { Power } from '../engine/types';
import { GameManager, type GameResult } from './manager';

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
  autostart?: boolean;
  postGamePress?: boolean;
  fastAdjudication?: boolean;
  allowDraws?: boolean;
}

export interface Lobby {
  id: string;
  config: LobbyConfig;
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  createdAt: number;
  creatorToken: string;
  seats: Map<Power, string>;
  manager: GameManager | null;
  result: GameResult | null;
}

export class LobbyManager {
  private lobbies = new Map<string, Lobby>();

  /** Called when a lobby is started — allows server.ts to wire agents and events. */
  private _onStart: ((id: string, manager: GameManager) => void | Promise<void>) | null = null;

  onStart(handler: (id: string, manager: GameManager) => void | Promise<void>): void {
    this._onStart = handler;
  }

  createLobby(config: LobbyConfig): { lobbyId: string; creatorToken: string } {
    const id = randomUUID().slice(0, 8);
    const creatorToken = randomUUID();
    const lobby: Lobby = {
      id,
      config,
      status: 'waiting',
      createdAt: Date.now(),
      creatorToken,
      seats: new Map(),
      manager: null,
      result: null,
    };
    this.lobbies.set(id, lobby);
    return { lobbyId: id, creatorToken };
  }

  joinLobby(lobbyId: string, power: Power): { seatToken: string } {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new Error(`Lobby ${lobbyId} not found`);
    if (lobby.status !== 'waiting') throw new Error(`Lobby ${lobbyId} is not accepting players`);
    if (lobby.seats.has(power)) throw new Error(`${power} is already claimed in lobby ${lobbyId}`);

    const seatToken = randomUUID();
    lobby.seats.set(power, seatToken);

    // Autostart if all 7 seats are filled
    const ALL_POWERS_COUNT = 7;
    if (lobby.config.autostart && lobby.seats.size === ALL_POWERS_COUNT) {
      this.startLobby(lobbyId).catch((err) => {
        console.error(`Autostart failed for lobby ${lobbyId}:`, err);
      });
    }

    return { seatToken };
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

    // Guard against concurrent starts
    lobby.status = 'starting';

    const config = lobby.config;
    const manager = new GameManager({
      maxYears: config.maxYears,
      victoryThreshold: config.victoryThreshold,
      startYear: config.startYear,
      phaseDelayMs: config.phaseDelayMs,
      remoteTimeoutMs: config.remoteTimeoutMs,
      pressDelayMin: config.pressDelayMin,
      pressDelayMax: config.pressDelayMax,
      fastAdjudication: config.fastAdjudication,
      allowDraws: config.allowDraws,
    });

    lobby.manager = manager;

    try {
      // Notify server to wire agents and start the game loop
      if (this._onStart) await this._onStart(id, manager);
    } catch (err) {
      // Roll back on failure
      lobby.manager = null;
      lobby.status = 'waiting';
      throw err;
    }

    lobby.status = 'playing';

    return manager;
  }

  kickPlayer(lobbyId: string, power: Power): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new Error(`Lobby ${lobbyId} not found`);
    if (lobby.status !== 'waiting') throw new Error(`Can only kick players in waiting status`);
    if (!lobby.seats.has(power)) throw new Error(`${power} has no seat in lobby ${lobbyId}`);
    lobby.seats.delete(power);
  }

  rejoinLobby(lobbyId: string, power: Power, oldToken: string): { seatToken: string } {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new Error(`Lobby ${lobbyId} not found`);
    if (lobby.status !== 'playing') throw new Error(`Lobby ${lobbyId} is not playing`);

    const currentToken = lobby.seats.get(power);
    if (!currentToken || currentToken !== oldToken) {
      throw new Error(`Invalid token for ${power} in lobby ${lobbyId}`);
    }

    const seatToken = randomUUID();
    lobby.seats.set(power, seatToken);
    return { seatToken };
  }

  validateToken(
    token: string,
  ): { lobbyId: string; power: Power } | { lobbyId: string; role: 'creator' } | null {
    for (const lobby of this.lobbies.values()) {
      if (lobby.creatorToken === token) {
        return { lobbyId: lobby.id, role: 'creator' };
      }
      for (const [power, seatToken] of lobby.seats) {
        if (seatToken === token) {
          return { lobbyId: lobby.id, power };
        }
      }
    }
    return null;
  }

  finishLobby(id: string, result?: GameResult): void {
    const lobby = this.lobbies.get(id);
    if (!lobby) return;
    lobby.status = 'finished';
    if (result) lobby.result = result;
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
