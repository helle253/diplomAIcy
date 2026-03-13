import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GameStorage } from './storage';

const DB_PATH = `test-storage-prompts-${process.pid}.db`;

let storage: GameStorage;

beforeEach(() => {
  storage = new GameStorage(DB_PATH);
});

afterEach(() => {
  storage.close();
  try {
    fs.unlinkSync(DB_PATH);
    fs.unlinkSync(`${DB_PATH}-wal`);
    fs.unlinkSync(`${DB_PATH}-shm`);
  } catch {
    // files may not exist
  }
});

describe('createPrompt', () => {
  it('creates a prompt with revision 1', () => {
    const result = storage.createPrompt('My Prompt', 'Hello world', 'private');

    expect(result.revision).toBe(1);
    expect(typeof result.promptId).toBe('string');
    expect(typeof result.ownerToken).toBe('string');
    expect(result.promptId).not.toBe(result.ownerToken);
  });

  it('defaults visibility to private', () => {
    const { promptId } = storage.createPrompt('Default', 'content');
    const prompt = storage.getPrompt(promptId);

    expect(prompt?.visibility).toBe('private');
  });
});

describe('getPrompt', () => {
  it('returns prompt with active revision content', () => {
    const { promptId } = storage.createPrompt('Test', 'Initial content', 'public');
    const prompt = storage.getPrompt(promptId);

    expect(prompt).toBeDefined();
    expect(prompt?.name).toBe('Test');
    expect(prompt?.content).toBe('Initial content');
    expect(prompt?.visibility).toBe('public');
    expect(prompt?.activeRevision).toBe(1);
  });

  it('returns undefined for non-existent prompt', () => {
    const prompt = storage.getPrompt('non-existent-id');
    expect(prompt).toBeUndefined();
  });
});

describe('updatePromptContent', () => {
  it('creates a new revision and bumps active_revision', () => {
    const { promptId } = storage.createPrompt('Test', 'v1 content', 'private');

    const newRevision = storage.updatePromptContent(promptId, 'v2 content');

    expect(newRevision).toBe(2);

    const prompt = storage.getPrompt(promptId);
    expect(prompt?.activeRevision).toBe(2);
    expect(prompt?.content).toBe('v2 content');
  });

  it('increments revision on each update', () => {
    const { promptId } = storage.createPrompt('Test', 'v1', 'private');

    storage.updatePromptContent(promptId, 'v2');
    const rev3 = storage.updatePromptContent(promptId, 'v3');

    expect(rev3).toBe(3);
    const prompt = storage.getPrompt(promptId);
    expect(prompt?.content).toBe('v3');
  });
});

describe('updatePromptMetadata', () => {
  it('updates name without creating a new revision', () => {
    const { promptId } = storage.createPrompt('Old Name', 'content', 'private');

    storage.updatePromptMetadata(promptId, { name: 'New Name' });

    const prompt = storage.getPrompt(promptId);
    expect(prompt?.name).toBe('New Name');
    expect(prompt?.activeRevision).toBe(1);
    expect(prompt?.content).toBe('content');
  });

  it('updates visibility without creating a new revision', () => {
    const { promptId } = storage.createPrompt('Test', 'content', 'private');

    storage.updatePromptMetadata(promptId, { visibility: 'public' });

    const prompt = storage.getPrompt(promptId);
    expect(prompt?.visibility).toBe('public');
    expect(prompt?.activeRevision).toBe(1);
  });

  it('updates both name and visibility together', () => {
    const { promptId } = storage.createPrompt('Old', 'content', 'private');

    storage.updatePromptMetadata(promptId, { name: 'New', visibility: 'public' });

    const prompt = storage.getPrompt(promptId);
    expect(prompt?.name).toBe('New');
    expect(prompt?.visibility).toBe('public');
    expect(prompt?.activeRevision).toBe(1);
  });
});

describe('getPromptRevision', () => {
  it('returns a specific revision', () => {
    const { promptId } = storage.createPrompt('Test', 'v1', 'private');
    storage.updatePromptContent(promptId, 'v2');

    const rev1 = storage.getPromptRevision(promptId, 1);
    expect(rev1?.revision).toBe(1);
    expect(rev1?.content).toBe('v1');

    const rev2 = storage.getPromptRevision(promptId, 2);
    expect(rev2?.revision).toBe(2);
    expect(rev2?.content).toBe('v2');
  });

  it('returns undefined for non-existent revision', () => {
    const { promptId } = storage.createPrompt('Test', 'v1', 'private');

    const rev = storage.getPromptRevision(promptId, 99);
    expect(rev).toBeUndefined();
  });
});

describe('listPromptRevisions', () => {
  it('returns all revisions ordered by revision ASC', () => {
    const { promptId } = storage.createPrompt('Test', 'v1', 'private');
    storage.updatePromptContent(promptId, 'v2');
    storage.updatePromptContent(promptId, 'v3');

    const revisions = storage.listPromptRevisions(promptId);

    expect(revisions).toHaveLength(3);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[0].content).toBe('v1');
    expect(revisions[1].revision).toBe(2);
    expect(revisions[1].content).toBe('v2');
    expect(revisions[2].revision).toBe(3);
    expect(revisions[2].content).toBe('v3');
  });

  it('returns empty array for unknown promptId', () => {
    const revisions = storage.listPromptRevisions('non-existent');
    expect(revisions).toHaveLength(0);
  });
});

describe('listPrompts', () => {
  it('returns public prompts only when no ownerToken provided', () => {
    const { ownerToken } = storage.createPrompt('Public One', 'content', 'public');
    storage.createPrompt('Private One', 'content', 'private');

    const results = storage.listPrompts();

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Public One');
    expect(results[0].ownerToken).toBe(ownerToken);
  });

  it('includes private prompts matching ownerToken', () => {
    const { ownerToken } = storage.createPrompt('My Private', 'content', 'private');
    storage.createPrompt('Others Private', 'content', 'private');
    storage.createPrompt('Public', 'content', 'public');

    const results = storage.listPrompts(ownerToken);

    const names = results.map((r) => r.name);
    expect(names).toContain('My Private');
    expect(names).toContain('Public');
    expect(names).not.toContain('Others Private');
  });

  it('does not include content field', () => {
    storage.createPrompt('Test', 'some content', 'public');

    const results = storage.listPrompts();

    expect(results).toHaveLength(1);
    expect('content' in results[0]).toBe(false);
  });
});

describe('deletePrompt', () => {
  it('removes the prompt', () => {
    const { promptId } = storage.createPrompt('To Delete', 'content', 'private');

    storage.deletePrompt(promptId);

    expect(storage.getPrompt(promptId)).toBeUndefined();
  });

  it('cascades to prompt_revisions', () => {
    const { promptId } = storage.createPrompt('To Delete', 'v1', 'private');
    storage.updatePromptContent(promptId, 'v2');

    storage.deletePrompt(promptId);

    const revisions = storage.listPromptRevisions(promptId);
    expect(revisions).toHaveLength(0);
  });
});

describe('snapshotGamePrompt', () => {
  it('uses active revision when no revision specified', () => {
    const gameId = storage.createGame();
    const { promptId } = storage.createPrompt('Test', 'active content', 'private');

    const snapshot = storage.snapshotGamePrompt(gameId, 'England', promptId);

    expect(snapshot.revision).toBe(1);
    expect(snapshot.contentSnapshot).toBe('active content');
  });

  it('uses specified revision', () => {
    const gameId = storage.createGame();
    const { promptId } = storage.createPrompt('Test', 'v1 content', 'private');
    storage.updatePromptContent(promptId, 'v2 content');

    const snapshot = storage.snapshotGamePrompt(gameId, 'England', promptId, 1);

    expect(snapshot.revision).toBe(1);
    expect(snapshot.contentSnapshot).toBe('v1 content');
  });

  it('atomically inserts the snapshot row and returns it', () => {
    const gameId = storage.createGame();
    const { promptId } = storage.createPrompt('Test', 'content', 'public');

    storage.snapshotGamePrompt(gameId, 'France', promptId);

    const gamePrompts = storage.getGamePrompts(gameId);
    expect(gamePrompts).toHaveLength(1);
    expect(gamePrompts[0].power).toBe('France');
    expect(gamePrompts[0].promptId).toBe(promptId);
    expect(gamePrompts[0].contentSnapshot).toBe('content');
  });

  it('throws for non-existent revision', () => {
    const gameId = storage.createGame();
    const { promptId } = storage.createPrompt('Test', 'content', 'private');

    expect(() => storage.snapshotGamePrompt(gameId, 'Germany', promptId, 99)).toThrow();
  });
});

describe('getGamePrompts', () => {
  it('returns all game prompts for a game', () => {
    const gameId = storage.createGame();
    const { promptId: p1 } = storage.createPrompt('Prompt1', 'c1', 'private');
    const { promptId: p2 } = storage.createPrompt('Prompt2', 'c2', 'private');

    storage.snapshotGamePrompt(gameId, 'England', p1);
    storage.snapshotGamePrompt(gameId, 'France', p2);

    const gamePrompts = storage.getGamePrompts(gameId);
    expect(gamePrompts).toHaveLength(2);

    const powers = gamePrompts.map((gp) => gp.power);
    expect(powers).toContain('England');
    expect(powers).toContain('France');
  });

  it('returns empty array for game with no prompts', () => {
    const gameId = storage.createGame();
    expect(storage.getGamePrompts(gameId)).toHaveLength(0);
  });
});
