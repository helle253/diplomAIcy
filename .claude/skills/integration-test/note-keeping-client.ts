import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';

import type { ChatMessage, LLMClient } from '../../../src/agent/llm/llm-client';

const NOTES_BLOCK_RE = /```notes\s*\n([\s\S]*?)```/;
const PHASE_RE = /=== (\w+ \d+) \((\w+)\) ===/;
const MAX_NOTES_CHARS = 2000;

/**
 * Extract a ```notes fenced block from an LLM response.
 * Returns the notes text and the response with the notes block stripped.
 */
export function extractNotesBlock(response: string): { notes: string | null; cleaned: string } {
  const match = response.match(NOTES_BLOCK_RE);
  if (!match) {
    return { notes: null, cleaned: response };
  }
  const notes = match[1].trim();
  const cleaned = response.replace(NOTES_BLOCK_RE, '').trim();
  return { notes: notes || null, cleaned };
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
    // 1. Read previous notes
    const previousNotes = await this.readNotes();

    // 2. Augment the last user message
    const augmented = messages.map((m, i) => {
      if (i === messages.length - 1 && m.role === 'user') {
        return { ...m, content: this.augmentPrompt(m.content, previousNotes) };
      }
      return m;
    });

    // 3. Call inner client
    const response = await this.inner.complete(augmented);

    // 4. Extract notes and save
    const { notes, cleaned } = extractNotesBlock(response);
    if (notes) {
      const phase = parsePhaseFromPrompt(messages[messages.length - 1]?.content ?? '');
      await this.saveNotes(phase, notes);
    }

    // 5. Return cleaned response
    return cleaned;
  }

  private augmentPrompt(prompt: string, previousNotes: string): string {
    const notesContent = previousNotes || '(none yet — this is your first phase)';
    return `${prompt}

--- Your Notes From Previous Phases ---
${notesContent}

--- Note-Taking Instructions ---
After your main JSON response, add a SECOND fenced block with your notes.
These notes are your external memory — you will see them in future phases.

\`\`\`notes
strategy: Your strategic observations, plans, alliance assessments, what worked/didn't
ux_feedback: Observations about prompt clarity, format confusion, what made it hard to play
\`\`\`

Notes are optional — if you have nothing to record, just submit your main response.`;
  }

  private async readNotes(): Promise<string> {
    try {
      const content = await readFile(this.notesFilePath, 'utf-8');
      if (content.length > MAX_NOTES_CHARS) {
        return '...(earlier notes truncated)...\n' + content.slice(-MAX_NOTES_CHARS);
      }
      return content;
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
