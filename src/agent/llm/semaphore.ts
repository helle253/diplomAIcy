import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { logger } from '../../util/logger';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means process exists but we lack permission to signal it
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    // ESRCH means no such process
    return false;
  }
}

/**
 * Cross-process semaphore using filesystem locks (mkdir is atomic).
 * Each slot is a directory; acquiring = creating it, releasing = removing it.
 * Supports N concurrent holders via N slot directories.
 */
export class FileSemaphore {
  private readonly lockDir: string;
  private heldSlot: number | null = null;

  constructor(
    private readonly max: number,
    options?: { directory?: string },
  ) {
    this.lockDir = options?.directory ?? join(tmpdir(), 'diplomaicy-llm-locks');
    mkdirSync(this.lockDir, { recursive: true });

    // Clean up stale locks from crashed processes on startup
    for (let i = 0; i < max; i++) {
      const slotDir = this.slotPath(i);
      try {
        const pidFile = join(slotDir, 'pid');
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (!isProcessAlive(pid)) {
          rmSync(slotDir, { recursive: true, force: true });
          logger.debug(`[LLM] Cleaned stale lock slot-${i} (pid ${pid})`);
        }
      } catch {
        // No slot dir or no pid file — nothing to clean
      }
    }

    // Release our slot on process exit
    process.on('exit', () => this.release());
    process.on('SIGTERM', () => {
      this.release();
      process.exit(128 + 15);
    });
    process.on('SIGINT', () => {
      this.release();
      process.exit(128 + 2);
    });
  }

  private slotPath(i: number): string {
    return join(this.lockDir, `slot-${i}`);
  }

  async acquire(): Promise<void> {
    while (true) {
      for (let i = 0; i < this.max; i++) {
        const dir = this.slotPath(i);
        try {
          mkdirSync(dir);
          writeFileSync(join(dir, 'pid'), String(process.pid));
          this.heldSlot = i;
          return;
        } catch {
          // Slot taken
        }
      }
      logger.debug(`[LLM] All ${this.max} slots busy, waiting...`);
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
    }
  }

  release(): void {
    if (this.heldSlot !== null) {
      try {
        rmSync(this.slotPath(this.heldSlot), { recursive: true, force: true });
      } catch {
        // Already removed
      }
      this.heldSlot = null;
    }
  }
}

// Limit concurrent LLM requests across all agent processes.
// With 7 agents each running tool loops, requests pile up and hit undici's
// 5-minute headersTimeout. The file semaphore ensures at most N requests
// reach Ollama at once, with the rest waiting in-process (no timeout).
const LLM_CONCURRENCY = Math.max(1, parseInt(process.env.LLM_CONCURRENCY ?? '1', 10) || 1);
export const llmSemaphore = new FileSemaphore(LLM_CONCURRENCY);
