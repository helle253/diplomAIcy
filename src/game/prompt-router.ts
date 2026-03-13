import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { GameStorage } from './storage';
import { publicProcedure, router } from './trpc';

// ── Zod schemas ────────────────────────────────────────────────────────

const visibilityEnum = z.enum(['public', 'private']);

const createInput = z.object({
  name: z.string().min(1).max(100),
  content: z.string().min(1).max(10000),
  visibility: visibilityEnum.default('private'),
});

const getInput = z.object({
  promptId: z.string(),
});

const updateInput = z.object({
  promptId: z.string(),
  content: z.string().min(1).max(10000).optional(),
  name: z.string().min(1).max(100).optional(),
  visibility: visibilityEnum.optional(),
});

const deleteInput = z.object({
  promptId: z.string(),
});

const listInput = z
  .object({
    promptToken: z.string().optional(),
  })
  .default({});

const getRevisionInput = z.object({
  promptId: z.string(),
  revision: z.number().int().min(1),
});

const listRevisionsInput = z.object({
  promptId: z.string(),
});

// ── Helper ─────────────────────────────────────────────────────────────

function checkVisibility(
  visibility: 'public' | 'private',
  ownerToken: string,
  ctxToken: string | null,
): void {
  if (visibility === 'public') return;
  if (ctxToken && ctxToken === ownerToken) return;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Prompt not found' });
}

// ── Router factory ─────────────────────────────────────────────────────

export function createPromptRouter(storage: GameStorage) {
  return router({
    create: publicProcedure.input(createInput).mutation(({ input }) => {
      const { promptId, ownerToken, revision } = storage.createPrompt(
        input.name,
        input.content,
        input.visibility,
      );
      return { promptId, promptToken: ownerToken, revision };
    }),

    get: publicProcedure.input(getInput).query(({ input, ctx }) => {
      const prompt = storage.getPrompt(input.promptId);
      if (!prompt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Prompt not found' });
      }
      checkVisibility(prompt.visibility, prompt.ownerToken, ctx.token);
      return prompt;
    }),

    update: publicProcedure.input(updateInput).mutation(({ input, ctx }) => {
      const prompt = storage.getPrompt(input.promptId);
      if (!prompt) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
      if (!ctx.token || ctx.token !== prompt.ownerToken) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }

      if (input.content !== undefined) {
        storage.updatePromptContent(input.promptId, input.content);
      }

      const metaUpdates: { name?: string; visibility?: 'public' | 'private' } = {};
      if (input.name !== undefined) metaUpdates.name = input.name;
      if (input.visibility !== undefined) metaUpdates.visibility = input.visibility;
      if (Object.keys(metaUpdates).length > 0) {
        storage.updatePromptMetadata(input.promptId, metaUpdates);
      }

      // Return current active_revision after all updates
      const updated = storage.getPrompt(input.promptId);
      return { revision: updated?.activeRevision ?? prompt.activeRevision };
    }),

    delete: publicProcedure.input(deleteInput).mutation(({ input, ctx }) => {
      const prompt = storage.getPrompt(input.promptId);
      if (!prompt) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
      if (!ctx.token || ctx.token !== prompt.ownerToken) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
      storage.deletePrompt(input.promptId);
      return { ok: true };
    }),

    list: publicProcedure.input(listInput).query(({ input, ctx }) => {
      const token = input.promptToken ?? ctx.token ?? undefined;
      return storage.listPrompts(token);
    }),

    getRevision: publicProcedure.input(getRevisionInput).query(({ input, ctx }) => {
      const prompt = storage.getPrompt(input.promptId);
      if (!prompt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Prompt not found' });
      }
      checkVisibility(prompt.visibility, prompt.ownerToken, ctx.token);

      const rev = storage.getPromptRevision(input.promptId, input.revision);
      if (!rev) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Revision not found' });
      }
      return rev;
    }),

    listRevisions: publicProcedure.input(listRevisionsInput).query(({ input, ctx }) => {
      const prompt = storage.getPrompt(input.promptId);
      if (!prompt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Prompt not found' });
      }
      checkVisibility(prompt.visibility, prompt.ownerToken, ctx.token);

      const revisions = storage.listPromptRevisions(input.promptId);
      return revisions.map(({ revision, createdAt }) => ({ revision, createdAt }));
    }),
  });
}

export type PromptRouter = ReturnType<typeof createPromptRouter>;
