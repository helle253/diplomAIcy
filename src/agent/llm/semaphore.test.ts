import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSemaphore } from './semaphore';

const lockDir = join(tmpdir(), 'diplomaicy-llm-locks');

function cleanLockDir() {
  rmSync(lockDir, { recursive: true, force: true });
}

afterEach(cleanLockDir);

describe('FileSemaphore', () => {
  it('acquires immediately when slots are free', async () => {
    const sem = new FileSemaphore(2);
    await sem.acquire();
    expect(existsSync(join(lockDir, 'slot-0'))).toBe(true);
    sem.release();
  });

  it('creates lock directory with pid file', async () => {
    const sem = new FileSemaphore(1);
    await sem.acquire();
    const pidFile = join(lockDir, 'slot-0', 'pid');
    expect(existsSync(pidFile)).toBe(true);
    sem.release();
  });

  it('release removes the slot directory', async () => {
    const sem = new FileSemaphore(1);
    await sem.acquire();
    expect(existsSync(join(lockDir, 'slot-0'))).toBe(true);
    sem.release();
    expect(existsSync(join(lockDir, 'slot-0'))).toBe(false);
  });

  it('release is idempotent', async () => {
    const sem = new FileSemaphore(1);
    await sem.acquire();
    sem.release();
    sem.release(); // should not throw
  });

  it('blocks when all slots are taken then acquires on release', async () => {
    const sem1 = new FileSemaphore(1);
    await sem1.acquire();

    const sem2 = new FileSemaphore(1);
    let acquired = false;
    const waiting = sem2.acquire().then(() => {
      acquired = true;
    });

    // Give the poll loop a chance to spin
    await new Promise((r) => setTimeout(r, 200));
    expect(acquired).toBe(false);

    sem1.release();
    await waiting;
    expect(acquired).toBe(true);

    sem2.release();
  });

  it('supports N concurrent holders', async () => {
    const sem1 = new FileSemaphore(2);
    const sem2 = new FileSemaphore(2);
    await sem1.acquire();
    await sem2.acquire();

    expect(existsSync(join(lockDir, 'slot-0'))).toBe(true);
    expect(existsSync(join(lockDir, 'slot-1'))).toBe(true);

    sem1.release();
    sem2.release();
  });

  it('cleans up stale locks from dead processes on startup', () => {
    // Simulate a stale lock left by a non-existent process
    const slotDir = join(lockDir, 'slot-0');
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, 'pid'), '999999999');

    // FileSemaphore constructor should clean it up
    const sem = new FileSemaphore(1);
    expect(existsSync(slotDir)).toBe(false);
    sem.release();
  });

  it('does not clean locks held by a live process', async () => {
    // Use our own pid — definitely alive
    const slotDir = join(lockDir, 'slot-0');
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, 'pid'), String(process.pid));

    // Constructor should NOT remove our live lock
    const sem = new FileSemaphore(1);
    expect(existsSync(slotDir)).toBe(true);

    // Clean up manually so other tests aren't affected
    rmSync(slotDir, { recursive: true, force: true });
    sem.release();
  });

  it('works under contention from concurrent acquirers', async () => {
    const concurrency = 2;
    let maxConcurrent = 0;
    let current = 0;

    const task = async () => {
      const sem = new FileSemaphore(concurrency);
      await sem.acquire();
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 50));
      current--;
      sem.release();
    };

    await Promise.all(Array.from({ length: 6 }, () => task()));

    expect(maxConcurrent).toBeLessThanOrEqual(concurrency);
    expect(current).toBe(0);
  });
});
