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

export interface StoredPrompt {
  id: string;
  name: string;
  ownerToken: string;
  visibility: 'public' | 'private';
  activeRevision: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPromptRevision {
  revision: number;
  content: string;
  createdAt: string;
}

export interface StoredGamePrompt {
  power: string;
  promptId: string;
  revision: number;
  contentSnapshot: string;
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

      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        active_revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS prompt_revisions (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(prompt_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_revisions_prompt ON prompt_revisions(prompt_id);

      CREATE TABLE IF NOT EXISTS game_prompts (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        power TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_snapshot TEXT NOT NULL,
        UNIQUE(game_id, power)
      );
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
  // Prompts
  // ===========================================================================

  createPrompt(
    name: string,
    content: string,
    visibility: 'public' | 'private' = 'private',
  ): { promptId: string; ownerToken: string; revision: 1 } {
    const promptId = randomUUID();
    const ownerToken = randomUUID();
    const revisionId = randomUUID();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO prompts (id, name, owner_token, visibility, active_revision) VALUES (?, ?, ?, ?, 1)`,
        )
        .run(promptId, name, ownerToken, visibility);

      this.db
        .prepare(
          `INSERT INTO prompt_revisions (id, prompt_id, revision, content) VALUES (?, ?, 1, ?)`,
        )
        .run(revisionId, promptId, content);
    });
    tx();

    return { promptId, ownerToken, revision: 1 };
  }

  getPrompt(promptId: string): StoredPrompt | undefined {
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.owner_token, p.visibility, p.active_revision, p.created_at, p.updated_at, pr.content
         FROM prompts p
         JOIN prompt_revisions pr ON pr.prompt_id = p.id AND pr.revision = p.active_revision
         WHERE p.id = ?`,
      )
      .get(promptId) as StoredPromptRow | undefined;

    if (!row) return undefined;
    return rowToStoredPrompt(row);
  }

  updatePromptContent(promptId: string, content: string): number {
    let newRevision = 0;

    const tx = this.db.transaction(() => {
      const prompt = this.db
        .prepare(`SELECT active_revision FROM prompts WHERE id = ?`)
        .get(promptId) as { active_revision: number } | undefined;

      if (!prompt) throw new Error(`Prompt not found: ${promptId}`);

      newRevision = prompt.active_revision + 1;
      const revisionId = randomUUID();

      this.db
        .prepare(
          `INSERT INTO prompt_revisions (id, prompt_id, revision, content) VALUES (?, ?, ?, ?)`,
        )
        .run(revisionId, promptId, newRevision, content);

      this.db
        .prepare(
          `UPDATE prompts SET active_revision = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(newRevision, promptId);
    });
    tx();

    return newRevision;
  }

  updatePromptMetadata(
    promptId: string,
    updates: { name?: string; visibility?: 'public' | 'private' },
  ): void {
    const fields: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      params.push(updates.name);
    }
    if (updates.visibility !== undefined) {
      fields.push('visibility = ?');
      params.push(updates.visibility);
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = datetime('now')`);
    params.push(promptId);

    this.db.prepare(`UPDATE prompts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  getPromptRevision(promptId: string, revision: number): StoredPromptRevision | undefined {
    const row = this.db
      .prepare(
        `SELECT revision, content, created_at FROM prompt_revisions WHERE prompt_id = ? AND revision = ?`,
      )
      .get(promptId, revision) as StoredPromptRevisionRow | undefined;

    if (!row) return undefined;
    return rowToStoredPromptRevision(row);
  }

  listPromptRevisions(promptId: string): StoredPromptRevision[] {
    const rows = this.db
      .prepare(
        `SELECT revision, content, created_at FROM prompt_revisions WHERE prompt_id = ? ORDER BY revision ASC`,
      )
      .all(promptId) as StoredPromptRevisionRow[];

    return rows.map(rowToStoredPromptRevision);
  }

  listPrompts(ownerToken?: string): Omit<StoredPrompt, 'content'>[] {
    let sql = `SELECT p.id, p.name, p.owner_token, p.visibility, p.active_revision, p.created_at, p.updated_at
               FROM prompts p
               WHERE p.visibility = 'public'`;
    const params: unknown[] = [];

    if (ownerToken) {
      sql += ` OR p.owner_token = ?`;
      params.push(ownerToken);
    }

    sql += ` ORDER BY p.created_at DESC`;

    const rows = this.db.prepare(sql).all(...params) as Omit<StoredPromptRow, 'content'>[];
    return rows.map(rowToStoredPromptMeta);
  }

  deletePrompt(promptId: string): void {
    this.db.prepare(`DELETE FROM prompts WHERE id = ?`).run(promptId);
  }

  snapshotGamePrompt(
    gameId: string,
    power: string,
    promptId: string,
    revision?: number,
  ): { revision: number; contentSnapshot: string } {
    let snapshotRevision = 0;
    let contentSnapshot = '';

    const tx = this.db.transaction(() => {
      if (revision !== undefined) {
        const rev = this.db
          .prepare(
            `SELECT revision, content FROM prompt_revisions WHERE prompt_id = ? AND revision = ?`,
          )
          .get(promptId, revision) as { revision: number; content: string } | undefined;

        if (!rev) throw new Error(`Revision ${revision} not found for prompt: ${promptId}`);

        snapshotRevision = rev.revision;
        contentSnapshot = rev.content;
      } else {
        const row = this.db
          .prepare(
            `SELECT pr.revision, pr.content
             FROM prompts p
             JOIN prompt_revisions pr ON pr.prompt_id = p.id AND pr.revision = p.active_revision
             WHERE p.id = ?`,
          )
          .get(promptId) as { revision: number; content: string } | undefined;

        if (!row) throw new Error(`Prompt not found: ${promptId}`);

        snapshotRevision = row.revision;
        contentSnapshot = row.content;
      }

      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO game_prompts (id, game_id, power, prompt_id, revision, content_snapshot) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, gameId, power, promptId, snapshotRevision, contentSnapshot);
    });
    tx();

    return { revision: snapshotRevision, contentSnapshot };
  }

  getGamePrompts(gameId: string): StoredGamePrompt[] {
    const rows = this.db
      .prepare(
        `SELECT power, prompt_id, revision, content_snapshot FROM game_prompts WHERE game_id = ?`,
      )
      .all(gameId) as StoredGamePromptRow[];

    return rows.map(rowToStoredGamePrompt);
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

interface StoredPromptRow {
  id: string;
  name: string;
  owner_token: string;
  visibility: string;
  active_revision: number;
  created_at: string;
  updated_at: string;
  content: string;
}

interface StoredPromptRevisionRow {
  revision: number;
  content: string;
  created_at: string;
}

interface StoredGamePromptRow {
  power: string;
  prompt_id: string;
  revision: number;
  content_snapshot: string;
}

function rowToStoredPrompt(row: StoredPromptRow): StoredPrompt {
  return {
    id: row.id,
    name: row.name,
    ownerToken: row.owner_token,
    visibility: row.visibility as 'public' | 'private',
    activeRevision: row.active_revision,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStoredPromptMeta(
  row: Omit<StoredPromptRow, 'content'>,
): Omit<StoredPrompt, 'content'> {
  return {
    id: row.id,
    name: row.name,
    ownerToken: row.owner_token,
    visibility: row.visibility as 'public' | 'private',
    activeRevision: row.active_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStoredPromptRevision(row: StoredPromptRevisionRow): StoredPromptRevision {
  return {
    revision: row.revision,
    content: row.content,
    createdAt: row.created_at,
  };
}

function rowToStoredGamePrompt(row: StoredGamePromptRow): StoredGamePrompt {
  return {
    power: row.power,
    promptId: row.prompt_id,
    revision: row.revision,
    contentSnapshot: row.content_snapshot,
  };
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
