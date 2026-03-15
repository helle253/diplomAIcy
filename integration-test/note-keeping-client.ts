import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';

import type {
  ChatMessage,
  LLMClient,
  ToolDefinition,
  ToolExecutor,
} from '../src/agent/llm/llm-client';

const NOTES_BLOCK_RE_GLOBAL = /```notes\s*\n([\s\S]*?)```/g;
const PHASE_RE = /=== (\w+ \d+) \((\w+)\) ===/;

export const MAX_NOTE_PHASES = 6;

/**
 * Extract a ```notes fenced block from an LLM response.
 * Returns the notes text and the response with the notes block stripped.
 */
export function extractNotesBlock(response: string): { notes: string | null; cleaned: string } {
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = NOTES_BLOCK_RE_GLOBAL.exec(response)) !== null) {
    const content = match[1].trim();
    if (content) matches.push(content);
  }
  NOTES_BLOCK_RE_GLOBAL.lastIndex = 0;

  if (matches.length === 0) {
    return { notes: null, cleaned: response };
  }

  const notes = matches.join('\n');
  const cleaned = response.replace(/```notes\s*\n[\s\S]*?```/g, '').trim();
  return { notes, cleaned };
}

/**
 * Extract phase info from the serialized game state in a prompt.
 * Matches the format produced by serializeGameState: "=== Spring 1901 (Orders) ==="
 */
export function parsePhaseFromPrompt(prompt: string): string {
  const match = prompt.match(PHASE_RE);
  if (!match) return 'Unknown Phase';
  return `${match[1]} ${match[2]}`;
}

/**
 * Trim notes to the last MAX_NOTE_PHASES phase sections to stay within context limits.
 */
export function truncateNotes(notes: string): string {
  const sections = notes.split(/(?=\n## )/);
  if (sections.length <= MAX_NOTE_PHASES) {
    return notes;
  }
  const kept = sections.slice(-MAX_NOTE_PHASES);
  return (
    `(Earlier notes omitted — showing last ${MAX_NOTE_PHASES} phases)\n\n` +
    kept.join('').trimStart()
  );
}

/**
 * Decorator around LLMClient that adds externalized note-taking.
 * Augments prompts with previous notes, extracts notes from responses,
 * and persists them to markdown files in the notes directory.
 */
export class NoteKeepingClient implements LLMClient {
  private notesFilePath: string;

  constructor(
    private inner: LLMClient,
    notesDir: string,
    private power: string,
    lobbyId: string,
  ) {
    this.notesFilePath = join(notesDir, lobbyId, `${power}.md`);
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const instructions =
      'After your main JSON response, add a SECOND fenced block with your notes.\n' +
      'These notes are your external memory — you will see them in future phases.';
    const augmented = await this.augmentMessages(messages, instructions);
    const response = await this.inner.complete(augmented);
    return this.extractAndSaveNotes(response, messages);
  }

  async runToolLoop(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
    maxIterations?: number,
  ): Promise<string> {
    if (!this.inner.runToolLoop) {
      throw new Error('Inner LLM client does not support tool calling');
    }
    const instructions =
      'You have external memory via notes. Include a ```notes fenced block with your\n' +
      'observations in any text response alongside your tool calls.\n\n' +
      'Notes are optional — if you have nothing to record, just submit your tools and finish.';
    const augmented = await this.augmentMessages(messages, instructions);
    const response = await this.inner.runToolLoop(augmented, tools, executor, maxIterations);
    const cleaned = await this.extractAndSaveNotes(response, messages);

    // If no notes were captured from the tool loop, do a cheap reflection call
    const { notes } = extractNotesBlock(response);
    if (!notes) {
      await this.reflectAfterPhase(messages, response);
    }

    return cleaned;
  }

  /**
   * Post-phase reflection: a cheap non-tool completion that asks the model
   * to summarize what it did and record notes for future phases.
   * Includes the original game state prompt and tool loop transcript for accuracy.
   */
  private async reflectAfterPhase(
    originalMessages: ChatMessage[],
    toolLoopTranscript: string,
  ): Promise<void> {
    const lastUserMsg = originalMessages[originalMessages.length - 1]?.content ?? '';
    const phase = parsePhaseFromPrompt(lastUserMsg);
    const previousNotes = await this.readNotes();
    const notesContext = previousNotes
      ? `Your notes so far:\n${truncateNotes(previousNotes)}`
      : '(No notes yet)';

    // Include the game state and what actually happened during the tool loop
    const gameContext =
      lastUserMsg.length > 3000 ? lastUserMsg.slice(0, 3000) + '...' : lastUserMsg;
    const transcript =
      toolLoopTranscript.length > 2000
        ? toolLoopTranscript.slice(0, 2000) + '...'
        : toolLoopTranscript;

    try {
      const reflection = await this.inner.complete([
        {
          role: 'system',
          content:
            `You are ${this.power} in a Diplomacy game. You just finished ${phase}.\n` +
            `${notesContext}\n\n` +
            'Briefly reflect on what happened this phase. Write a ```notes block with:\n' +
            'strategy: What you did, why, alliance status, threats\n' +
            'ux_feedback: Any issues with the interface or prompts',
        },
        {
          role: 'user',
          content:
            `Here is the game state you saw this phase:\n${gameContext}\n\n` +
            (transcript
              ? `Here is what you did (tool calls and responses):\n${transcript}\n\n`
              : '') +
            'Write your notes for this phase.',
        },
      ]);
      const { notes } = extractNotesBlock(reflection);
      if (notes) {
        await this.saveNotes(phase, notes);
      }
    } catch (error) {
      console.warn(`[${this.power}] Reflection call failed:`, error);
    }
  }

  private async augmentMessages(
    messages: ChatMessage[],
    instructions: string,
  ): Promise<ChatMessage[]> {
    const previousNotes = await this.readNotes();
    const notesContent = previousNotes
      ? truncateNotes(previousNotes)
      : '(none yet — this is your first phase)';
    const suffix =
      `\n\n--- Your Notes From Previous Phases ---\n${notesContent}` +
      `\n\n--- Note-Taking Instructions ---\n${instructions}` +
      '\n\n```notes\n' +
      "strategy: Your strategic observations, plans, alliance assessments, what worked/didn't\n" +
      'ux_feedback: Observations about prompt clarity, format confusion, what made it hard to play\n' +
      '```\n\n' +
      'Notes are optional — if you have nothing to record, just submit your main response.';

    return messages.map((m, i) => {
      if (i === messages.length - 1 && m.role === 'user') {
        return { ...m, content: m.content + suffix };
      }
      return m;
    });
  }

  private async extractAndSaveNotes(
    response: string,
    originalMessages: ChatMessage[],
  ): Promise<string> {
    const { notes, cleaned } = extractNotesBlock(response);
    if (notes) {
      const phase = parsePhaseFromPrompt(
        originalMessages[originalMessages.length - 1]?.content ?? '',
      );
      try {
        await this.saveNotes(phase, notes);
      } catch (error) {
        console.warn(`Failed to persist notes for ${this.power} at ${phase}:`, error);
      }
    }
    return cleaned;
  }

  private async readNotes(): Promise<string> {
    try {
      return await readFile(this.notesFilePath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async saveNotes(phase: string, notes: string): Promise<void> {
    const header = `\n## ${phase}\n\n`;
    const lines = notes.split('\n');
    let formatted = '';

    for (const line of lines) {
      const strategyMatch = line.match(/^strategy:\s*(.*)/i);
      const uxMatch = line.match(/^ux_feedback:\s*(.*)/i);
      if (strategyMatch) {
        formatted += `### Strategy\n${strategyMatch[1]}\n`;
      } else if (uxMatch) {
        formatted += `\n### UX Feedback\n${uxMatch[1]}\n`;
      } else if (line.trim()) {
        formatted += `${line}\n`;
      }
    }

    if (!formatted.trim()) {
      formatted = notes + '\n';
    }

    // Ensure directory exists and append
    await mkdir(dirname(this.notesFilePath), { recursive: true });
    await appendFile(this.notesFilePath, header + formatted);
  }
}
