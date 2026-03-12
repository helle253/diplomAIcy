import { mkdir as fsMkdir, mkdtemp, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatMessage, LLMClient } from '../../../src/agent/llm/llm-client';

import { extractNotesBlock, NoteKeepingClient, parsePhaseFromPrompt } from './note-keeping-client';

describe('extractNotesBlock', () => {
  it('extracts notes from a response with json + notes fences', () => {
    const response = [
      '```json',
      '[{ "unit": "par", "type": "move", "destination": "bur" }]',
      '```',
      '',
      '```notes',
      'strategy: Moving to Burgundy to secure the center.',
      'ux_feedback: Province list was helpful.',
      '```',
    ].join('\n');

    const result = extractNotesBlock(response);
    expect(result.notes).toContain('strategy: Moving to Burgundy');
    expect(result.notes).toContain('ux_feedback: Province list was helpful.');
    expect(result.cleaned).not.toContain('```notes');
    expect(result.cleaned).toContain('```json');
    expect(result.cleaned).toContain('"destination": "bur"');
  });

  it('returns null notes when no notes block present', () => {
    const response = '```json\n[{ "unit": "par", "type": "hold" }]\n```';
    const result = extractNotesBlock(response);
    expect(result.notes).toBeNull();
    expect(result.cleaned).toBe(response);
  });

  it('handles notes block before json block', () => {
    const response = [
      '```notes',
      'strategy: Holding position.',
      '```',
      '',
      '```json',
      '[{ "unit": "par", "type": "hold" }]',
      '```',
    ].join('\n');

    const result = extractNotesBlock(response);
    expect(result.notes).toContain('strategy: Holding position.');
    expect(result.cleaned).toContain('"type": "hold"');
    expect(result.cleaned).not.toContain('```notes');
  });

  it('handles response with no fenced blocks at all', () => {
    const response = '[{ "unit": "par", "type": "hold" }]';
    const result = extractNotesBlock(response);
    expect(result.notes).toBeNull();
    expect(result.cleaned).toBe(response);
  });

  it('handles notes block with extra whitespace', () => {
    const response = '```json\n[]\n```\n\n```notes  \n  strategy: test  \n```\n';
    const result = extractNotesBlock(response);
    expect(result.notes).toContain('strategy: test');
  });
});

describe('parsePhaseFromPrompt', () => {
  it('extracts phase from orders prompt', () => {
    const prompt = '=== Spring 1901 (Orders) ===\nYOUR POWER: France\n...';
    expect(parsePhaseFromPrompt(prompt)).toBe('Spring 1901 Orders');
  });

  it('extracts phase from retreats prompt', () => {
    const prompt = '=== Fall 1901 (Retreats) ===\nYOUR POWER: England\n...';
    expect(parsePhaseFromPrompt(prompt)).toBe('Fall 1901 Retreats');
  });

  it('returns Unknown Phase when pattern not found', () => {
    const prompt = 'Some prompt without phase header';
    expect(parsePhaseFromPrompt(prompt)).toBe('Unknown Phase');
  });
});

class MockLLMClient implements LLMClient {
  response = '```json\n[]\n```';
  lastMessages: ChatMessage[] = [];

  async complete(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    return this.response;
  }
}

describe('NoteKeepingClient', () => {
  let tmpDir: string;
  let mockClient: MockLLMClient;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'notes-test-'));
    mockClient = new MockLLMClient();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('augments prompt with note-taking instructions', async () => {
    const client = new NoteKeepingClient(mockClient, tmpDir, 'France', 'lobby123');
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are France.' },
      { role: 'user', content: '=== Spring 1901 (Orders) ===\nSubmit orders.' },
    ];

    await client.complete(messages);

    const lastUserMsg = mockClient.lastMessages.find((m) => m.role === 'user')!;
    expect(lastUserMsg.content).toContain('--- Your Notes From Previous Phases ---');
    expect(lastUserMsg.content).toContain('(none yet');
    expect(lastUserMsg.content).toContain('--- Note-Taking Instructions ---');
  });

  it('extracts notes and saves to file', async () => {
    mockClient.response = [
      '```json',
      '[{ "unit": "par", "type": "hold" }]',
      '```',
      '',
      '```notes',
      'strategy: Holding Paris for now.',
      'ux_feedback: Clear format.',
      '```',
    ].join('\n');

    const client = new NoteKeepingClient(mockClient, tmpDir, 'France', 'lobby123');
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: '=== Spring 1901 (Orders) ===\nSubmit.' },
    ];

    const result = await client.complete(messages);

    // Returned response should not contain notes
    expect(result).not.toContain('```notes');
    expect(result).toContain('"type": "hold"');

    // Notes file should exist with content
    const notesPath = join(tmpDir, 'lobby123', 'France.md');
    const saved = await fsReadFile(notesPath, 'utf-8');
    expect(saved).toContain('## Spring 1901 Orders');
    expect(saved).toContain('Holding Paris for now.');
    expect(saved).toContain('Clear format.');
  });

  it('injects previous notes and appends across phases', async () => {
    // First call: saves notes
    mockClient.response = '```json\n[]\n```\n\n```notes\nstrategy: Plan A.\n```';
    const client = new NoteKeepingClient(mockClient, tmpDir, 'France', 'lobby123');

    await client.complete([
      { role: 'system', content: 'Sys' },
      { role: 'user', content: '=== Spring 1901 (Orders) ===\nGo.' },
    ]);

    // Second call: saves more notes, should see previous ones in prompt
    mockClient.response = '```json\n[]\n```\n\n```notes\nstrategy: Plan B.\n```';
    await client.complete([
      { role: 'system', content: 'Sys' },
      { role: 'user', content: '=== Fall 1901 (Orders) ===\nGo.' },
    ]);

    // Prompt should contain previous notes
    const lastUserMsg = mockClient.lastMessages.find((m) => m.role === 'user')!;
    expect(lastUserMsg.content).toContain('Plan A.');

    // File should contain both phases
    const notesPath = join(tmpDir, 'lobby123', 'France.md');
    const saved = await fsReadFile(notesPath, 'utf-8');
    expect(saved).toContain('## Spring 1901 Orders');
    expect(saved).toContain('Plan A.');
    expect(saved).toContain('## Fall 1901 Orders');
    expect(saved).toContain('Plan B.');
  });

  it('passes through response unchanged when no notes block', async () => {
    mockClient.response = '```json\n[{ "unit": "par", "type": "hold" }]\n```';
    const client = new NoteKeepingClient(mockClient, tmpDir, 'England', 'lobby456');

    const result = await client.complete([
      { role: 'system', content: 'Sys' },
      { role: 'user', content: '=== Spring 1901 (Orders) ===\nGo.' },
    ]);

    expect(result).toBe(mockClient.response);
  });

  it('truncates notes injection to MAX_NOTES_CHARS', async () => {
    const dir = join(tmpDir, 'lobby789');
    await fsMkdir(dir, { recursive: true });
    const bigNotes = 'x'.repeat(5000);
    await fsWriteFile(join(dir, 'Russia.md'), bigNotes);

    mockClient.response = '```json\n[]\n```';
    const client = new NoteKeepingClient(mockClient, tmpDir, 'Russia', 'lobby789');

    await client.complete([
      { role: 'system', content: 'Sys' },
      { role: 'user', content: '=== Spring 1901 (Orders) ===\nGo.' },
    ]);

    const lastUserMsg = mockClient.lastMessages.find((m) => m.role === 'user')!;
    // The injected notes portion should be truncated
    const notesSection = lastUserMsg.content.split('--- Your Notes From Previous Phases ---')[1];
    const noteContent = notesSection.split('--- Note-Taking Instructions ---')[0];
    expect(noteContent.length).toBeLessThanOrEqual(2200); // 2000 + some truncation message overhead
  });
});
