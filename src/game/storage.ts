import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { Message, Phase, Power } from '../engine/types';
import type { GameResult, TurnRecord } from './manager';

export interface StoredGame {
  id: string;
  startedAt: string;
  endedAt: string | null;
  winner: string | null;
  year: number;
  status: 'in_progress' | 'completed' | 'error';
}

export class GameStorage {
  private db: Database.Database;

  constructor(dbPath = 'diplomaicy.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        winner TEXT,
        year INTEGER NOT NULL DEFAULT 1901,
        status TEXT NOT NULL DEFAULT 'in_progress'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        content TEXT NOT NULL,
        phase_year INTEGER NOT NULL,
        phase_season TEXT NOT NULL,
        phase_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_game ON messages(game_id);
      CREATE INDEX IF NOT EXISTS idx_messages_game_phase ON messages(game_id, phase_year, phase_season);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(game_id, "to");

      CREATE TABLE IF NOT EXISTS turn_records (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        phase_year INTEGER NOT NULL,
        phase_season TEXT NOT NULL,
        phase_type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_turns_game ON turn_records(game_id);
    `);
  }

  // ===========================================================================
  // Games
  // ===========================================================================

  createGame(): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO games (id) VALUES (?)`).run(id);
    return id;
  }

  completeGame(gameId: string, result: GameResult): void {
    this.db
      .prepare(
        `UPDATE games SET ended_at = datetime('now'), winner = ?, year = ?, status = 'completed' WHERE id = ?`,
      )
      .run(result.winner, result.year, gameId);
  }

  failGame(gameId: string): void {
    this.db
      .prepare(`UPDATE games SET ended_at = datetime('now'), status = 'error' WHERE id = ?`)
      .run(gameId);
  }

  getGame(gameId: string): StoredGame | undefined {
    return this.db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId) as
      | StoredGame
      | undefined;
  }

  listGames(limit = 20): StoredGame[] {
    return this.db
      .prepare(`SELECT * FROM games ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as StoredGame[];
  }

  // ===========================================================================
  // Messages
  // ===========================================================================

  saveMessage(gameId: string, message: Message): string {
    const id = message.id ?? randomUUID();
    const to = serializeTo(message.to);
    this.db
      .prepare(
        `INSERT INTO messages (id, game_id, "from", "to", content, phase_year, phase_season, phase_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        gameId,
        message.from,
        to,
        message.content,
        message.phase.year,
        message.phase.season,
        message.phase.type,
        message.timestamp,
      );
    return id;
  }

  saveMessages(gameId: string, messages: Message[]): void {
    const insert = this.db.prepare(
      `INSERT INTO messages (id, game_id, "from", "to", content, phase_year, phase_season, phase_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((msgs: Message[]) => {
      for (const msg of msgs) {
        const id = msg.id ?? randomUUID();
        insert.run(
          id,
          gameId,
          msg.from,
          serializeTo(msg.to),
          msg.content,
          msg.phase.year,
          msg.phase.season,
          msg.phase.type,
          msg.timestamp,
        );
      }
    });
    tx(messages);
  }

  getMessages(
    gameId: string,
    options?: {
      power?: Power;
      phase?: Phase;
      limit?: number;
    },
  ): Message[] {
    let sql = `SELECT * FROM messages WHERE game_id = ?`;
    const params: unknown[] = [gameId];

    if (options?.power) {
      // Messages sent to this power, sent by this power, or global
      sql += ` AND ("from" = ? OR "to" = ? OR "to" LIKE ? OR "to" = 'Global')`;
      params.push(options.power, options.power, `%${options.power}%`);
    }

    if (options?.phase) {
      sql += ` AND phase_year = ? AND phase_season = ?`;
      params.push(options.phase.year, options.phase.season);
    }

    sql += ` ORDER BY timestamp ASC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as StoredMessageRow[];
    return rows.map(rowToMessage);
  }

  // ===========================================================================
  // Turn Records
  // ===========================================================================

  saveTurnRecord(gameId: string, record: TurnRecord): void {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO turn_records (id, game_id, phase_year, phase_season, phase_type, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        gameId,
        record.phase.year,
        record.phase.season,
        record.phase.type,
        JSON.stringify(record),
      );
  }

  getTurnRecords(gameId: string): TurnRecord[] {
    const rows = this.db
      .prepare(`SELECT data FROM turn_records WHERE game_id = ? ORDER BY phase_year, phase_season`)
      .all(gameId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  close(): void {
    this.db.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

interface StoredMessageRow {
  id: string;
  game_id: string;
  from: string;
  to: string;
  content: string;
  phase_year: number;
  phase_season: string;
  phase_type: string;
  timestamp: number;
}

function serializeTo(to: Power | Power[] | 'Global'): string {
  if (Array.isArray(to)) {
    return to.join(',');
  }
  return to;
}

function deserializeTo(to: string): Power | Power[] | 'Global' {
  if (to === 'Global') return 'Global';
  if (to.includes(',')) {
    return to.split(',') as Power[];
  }
  return to as Power;
}

function rowToMessage(row: StoredMessageRow): Message {
  return {
    id: row.id,
    from: row.from as Power,
    to: deserializeTo(row.to),
    content: row.content,
    phase: {
      year: row.phase_year,
      season: row.phase_season,
      type: row.phase_type,
    } as Phase,
    timestamp: row.timestamp,
  };
}
