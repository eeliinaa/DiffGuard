// Concurrency-limited task queue — pure slot/semaphore pattern.
// maxConcurrency is clamped to [1, 3] (hard cap per DiffGuard spec).

export interface ConcurrentTask<T> {
  run: () => Promise<T>;
  label: string;
}

/**
 * Runs tasks with at most `maxConcurrency` active at a time (hard cap: 3).
 * Failure isolation: if a task throws, the error is logged and null is stored
 * for that slot — remaining tasks continue uninterrupted.
 *
 * Tasks are claimed atomically (JS single-thread guarantee) before each
 * await, so there is no double-processing across concurrent workers.
 */
export async function runConcurrent<T>(
  tasks: ConcurrentTask<T>[],
  maxConcurrency: number,
): Promise<Array<T | null>> {
  const concurrency = Math.min(Math.max(1, maxConcurrency), 3);
  const results: Array<T | null> = new Array(tasks.length).fill(null);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      // Claim the next task index before yielding — safe due to JS single thread.
      const index = nextIndex++;
      const task = tasks[index];
      try {
        results[index] = await task.run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DiffGuard][queue] Task failed: ${task.label} — ${message}`);
        results[index] = null;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
