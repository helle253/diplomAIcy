import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSemaphore } from './semaphore';

const dirs: string[] = [];

/** Create an isolated lock directory per test so parallel runs can't interfere. */
function testDir(): string {
  const dir = join(
    tmpdir(),
    `diplomaicy-sem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('FileSemaphore', () => {
  it('acquires immediately when slots are free', async () => {
    const dir = testDir();
    const sem = new FileSemaphore(2, { directory: dir });
    await sem.acquire();
    expect(existsSync(join(dir, 'slot-0'))).toBe(true);
    sem.release();
  });

  it('creates lock directory with pid file', async () => {
    const dir = testDir();
    const sem = new FileSemaphore(1, { directory: dir });
    await sem.acquire();
    expect(existsSync(join(dir, 'slot-0', 'pid'))).toBe(true);
    sem.release();
  });

  it('release removes the slot directory', async () => {
    const dir = testDir();
    const sem = new FileSemaphore(1, { directory: dir });
    await sem.acquire();
    expect(existsSync(join(dir, 'slot-0'))).toBe(true);
    sem.release();
    expect(existsSync(join(dir, 'slot-0'))).toBe(false);
  });

  it('release is idempotent', async () => {
    const dir = testDir();
    const sem = new FileSemaphore(1, { directory: dir });
    await sem.acquire();
    sem.release();
    sem.release(); // should not throw
  });

  it('blocks when all slots are taken then acquires on release', async () => {
    const dir = testDir();
    const sem1 = new FileSemaphore(1, { directory: dir });
    await sem1.acquire();

    const sem2 = new FileSemaphore(1, { directory: dir });
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
    const dir = testDir();
    const sem1 = new FileSemaphore(2, { directory: dir });
    const sem2 = new FileSemaphore(2, { directory: dir });
    await sem1.acquire();
    await sem2.acquire();

    expect(existsSync(join(dir, 'slot-0'))).toBe(true);
    expect(existsSync(join(dir, 'slot-1'))).toBe(true);

    sem1.release();
    sem2.release();
  });

  it('cleans up stale locks from dead processes on startup', () => {
    const dir = testDir();
    const slotDir = join(dir, 'slot-0');
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, 'pid'), '999999999');

    const sem = new FileSemaphore(1, { directory: dir });
    expect(existsSync(slotDir)).toBe(false);
    sem.release();
  });

  it('does not clean locks held by a live process', async () => {
    const dir = testDir();
    const slotDir = join(dir, 'slot-0');
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, 'pid'), String(process.pid));

    const sem = new FileSemaphore(1, { directory: dir });
    expect(existsSync(slotDir)).toBe(true);

    rmSync(slotDir, { recursive: true, force: true });
    sem.release();
  });

  it('works under contention from concurrent acquirers', async () => {
    const dir = testDir();
    const concurrency = 2;
    let maxConcurrent = 0;
    let current = 0;

    const task = async () => {
      const sem = new FileSemaphore(concurrency, { directory: dir });
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
