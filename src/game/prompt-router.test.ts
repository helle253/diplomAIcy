import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPromptRouter } from './prompt-router';
import { GameStorage } from './storage';
import { createContext, router } from './trpc';

const DB_PATH = `test-prompt-router-${process.pid}.db`;

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

function createCaller(token?: string) {
  const promptRouter = createPromptRouter(storage);
  const appRouter = router({ prompt: promptRouter });
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return appRouter.createCaller(createContext({ req: { headers } }));
}

describe('prompt.create', () => {
  it('returns promptId, promptToken, and revision 1', async () => {
    const caller = createCaller();
    const result = await caller.prompt.create({ name: 'My Prompt', content: 'Hello world' });

    expect(result.revision).toBe(1);
    expect(typeof result.promptId).toBe('string');
    expect(typeof result.promptToken).toBe('string');
    expect(result.promptId).not.toBe(result.promptToken);
  });

  it('defaults visibility to private', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'Private',
      content: 'content',
    });
    const authed = createCaller(promptToken);
    const prompt = await authed.prompt.get({ promptId });
    expect(prompt.visibility).toBe('private');
  });

  it('rejects content longer than 10000 characters', async () => {
    const caller = createCaller();
    await expect(
      caller.prompt.create({ name: 'Too long', content: 'x'.repeat(10001) }),
    ).rejects.toThrow();
  });

  it('can create a public prompt', async () => {
    const caller = createCaller();
    const { promptId } = await caller.prompt.create({
      name: 'Public',
      content: 'public content',
      visibility: 'public',
    });
    const prompt = await caller.prompt.get({ promptId });
    expect(prompt.visibility).toBe('public');
  });
});

describe('prompt.get', () => {
  it('returns public prompt without token', async () => {
    const owner = createCaller();
    const { promptId } = await owner.prompt.create({
      name: 'Public',
      content: 'public content',
      visibility: 'public',
    });

    const anon = createCaller();
    const prompt = await anon.prompt.get({ promptId });
    expect(prompt.name).toBe('Public');
    expect(prompt.content).toBe('public content');
  });

  it('rejects private prompt without token with NOT_FOUND', async () => {
    const owner = createCaller();
    const { promptId } = await owner.prompt.create({
      name: 'Private',
      content: 'secret',
      visibility: 'private',
    });

    const anon = createCaller();
    await expect(anon.prompt.get({ promptId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns private prompt with correct token', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'Private',
      content: 'secret',
      visibility: 'private',
    });

    const authed = createCaller(promptToken);
    const prompt = await authed.prompt.get({ promptId });
    expect(prompt.content).toBe('secret');
  });
});

describe('prompt.update', () => {
  it('creates a new revision on content change', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'Test',
      content: 'v1',
    });

    const authed = createCaller(promptToken);
    const result = await authed.prompt.update({ promptId, content: 'v2' });
    expect(result.revision).toBe(2);
  });

  it('metadata-only update does not bump revision', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'Test',
      content: 'v1',
    });

    const authed = createCaller(promptToken);
    const result = await authed.prompt.update({ promptId, name: 'Updated Name' });
    expect(result.revision).toBe(1);

    const prompt = await authed.prompt.get({ promptId });
    expect(prompt.name).toBe('Updated Name');
  });

  it('rejects update without valid token with UNAUTHORIZED', async () => {
    const caller = createCaller();
    const { promptId } = await caller.prompt.create({ name: 'Test', content: 'v1' });

    const anon = createCaller();
    await expect(anon.prompt.update({ promptId, content: 'v2' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects update with wrong token', async () => {
    const caller = createCaller();
    const { promptId } = await caller.prompt.create({ name: 'Test', content: 'v1' });

    const wrong = createCaller('wrong-token');
    await expect(wrong.prompt.update({ promptId, content: 'v2' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('prompt.delete', () => {
  it('deletes prompt with correct token', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'ToDelete',
      content: 'bye',
      visibility: 'public',
    });

    const authed = createCaller(promptToken);
    const result = await authed.prompt.delete({ promptId });
    expect(result.ok).toBe(true);
  });

  it('prompt is gone after delete', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'ToDelete',
      content: 'bye',
      visibility: 'public',
    });

    const authed = createCaller(promptToken);
    await authed.prompt.delete({ promptId });

    const anon = createCaller();
    await expect(anon.prompt.get({ promptId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects delete without valid token', async () => {
    const caller = createCaller();
    const { promptId } = await caller.prompt.create({
      name: 'Test',
      content: 'content',
      visibility: 'public',
    });

    const anon = createCaller();
    await expect(anon.prompt.delete({ promptId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('prompt.list', () => {
  it('returns only public prompts without token', async () => {
    const caller = createCaller();
    await caller.prompt.create({ name: 'Public', content: 'pub', visibility: 'public' });
    await caller.prompt.create({ name: 'Private', content: 'priv', visibility: 'private' });

    const anon = createCaller();
    const results = await anon.prompt.list({});
    expect(results.some((p) => p.name === 'Public')).toBe(true);
    expect(results.some((p) => p.name === 'Private')).toBe(false);
  });

  it('includes private prompts with matching token', async () => {
    const caller = createCaller();
    const { promptToken } = await caller.prompt.create({
      name: 'Private',
      content: 'priv',
      visibility: 'private',
    });

    const authed = createCaller(promptToken);
    const results = await authed.prompt.list({});
    expect(results.some((p) => p.name === 'Private')).toBe(true);
  });

  it('uses promptToken input over ctx token', async () => {
    const caller = createCaller();
    const { promptToken } = await caller.prompt.create({
      name: 'Private',
      content: 'priv',
      visibility: 'private',
    });

    // Pass promptToken explicitly in input (no bearer token)
    const anon = createCaller();
    const results = await anon.prompt.list({ promptToken });
    expect(results.some((p) => p.name === 'Private')).toBe(true);
  });
});

describe('prompt.getRevision', () => {
  it('returns specific revision content', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'Test',
      content: 'v1',
      visibility: 'public',
    });

    const authed = createCaller(promptToken);
    await authed.prompt.update({ promptId, content: 'v2' });

    const rev1 = await caller.prompt.getRevision({ promptId, revision: 1 });
    expect(rev1.content).toBe('v1');

    const rev2 = await caller.prompt.getRevision({ promptId, revision: 2 });
    expect(rev2.content).toBe('v2');
  });

  it('rejects private prompt revision without token', async () => {
    const caller = createCaller();
    const { promptId } = await caller.prompt.create({
      name: 'Private',
      content: 'secret',
      visibility: 'private',
    });

    const anon = createCaller();
    await expect(anon.prompt.getRevision({ promptId, revision: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('prompt.listRevisions', () => {
  it('returns all revision metadata', async () => {
    const caller = createCaller();
    const { promptId, promptToken } = await caller.prompt.create({
      name: 'Test',
      content: 'v1',
      visibility: 'public',
    });

    const authed = createCaller(promptToken);
    await authed.prompt.update({ promptId, content: 'v2' });
    await authed.prompt.update({ promptId, content: 'v3' });

    const revisions = await caller.prompt.listRevisions({ promptId });
    expect(revisions).toHaveLength(3);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[1].revision).toBe(2);
    expect(revisions[2].revision).toBe(3);
    // Should not include content
    expect('content' in revisions[0]).toBe(false);
  });

  it('rejects private prompt revisions without token', async () => {
    const caller = createCaller();
    const { promptId } = await caller.prompt.create({
      name: 'Private',
      content: 'secret',
      visibility: 'private',
    });

    const anon = createCaller();
    await expect(anon.prompt.listRevisions({ promptId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
