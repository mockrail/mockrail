import type { IdGenerator } from '../shared/ids.js';
import type { Store } from '../store/store.js';

export interface ScheduledJob<P = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly runAt: string;
  readonly payload: P;
  readonly seq: number;
  readonly key?: string;
  readonly createdAt: string;
}

export interface ScheduledJobResult {
  readonly jobId: string;
  readonly kind: string;
  readonly runAt: string;
  readonly ok: boolean;
  readonly error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobHandler<P = any> = (payload: P, job: ScheduledJob<P>) => void | Promise<void>;

const JOBS = 'jobs';
const META = 'meta';

interface SequenceRecord {
  readonly id: 'job-sequence';
  readonly value: number;
}

/**
 * Jobs keyed on virtual time. Jobs live in the store so they survive snapshots and restarts;
 * handlers are registered in code by job kind.
 */
export class Scheduler {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly store: Store,
    private readonly ids: IdGenerator,
    private readonly nowIso: () => string,
  ) {}

  register<P>(kind: string, handler: JobHandler<P>): void {
    if (this.handlers.has(kind)) throw new Error(`Job handler already registered for '${kind}'`);
    this.handlers.set(kind, handler as JobHandler);
  }

  schedule<P>(kind: string, runAt: Date, payload: P, options: { key?: string } = {}): ScheduledJob<P> {
    if (options.key) this.cancelByKey(options.key);
    const job: ScheduledJob<P> = {
      id: this.ids.next('job'),
      kind,
      runAt: runAt.toISOString(),
      payload,
      seq: this.nextSeq(),
      createdAt: this.nowIso(),
      ...(options.key ? { key: options.key } : {}),
    };
    this.store.put(JOBS, job);
    return job;
  }

  cancel(jobId: string): boolean {
    return this.store.delete(JOBS, jobId);
  }

  cancelByKey(key: string): number {
    const matches = this.store.list<ScheduledJob>(JOBS, (job) => job.key === key);
    for (const job of matches) this.store.delete(JOBS, job.id);
    return matches.length;
  }

  pending(): ScheduledJob[] {
    return this.store.list<ScheduledJob>(JOBS).sort(compareJobs);
  }

  /** Earliest job due at or before `at`. */
  nextDue(at: Date): ScheduledJob | undefined {
    const limit = at.getTime();
    let best: ScheduledJob | undefined;
    for (const job of this.store.list<ScheduledJob>(JOBS)) {
      if (Date.parse(job.runAt) > limit) continue;
      if (!best || compareJobs(job, best) < 0) best = job;
    }
    return best;
  }

  async run(job: ScheduledJob): Promise<ScheduledJobResult> {
    this.store.delete(JOBS, job.id);
    const handler = this.handlers.get(job.kind);
    const base = { jobId: job.id, kind: job.kind, runAt: job.runAt };
    if (!handler) return { ...base, ok: false, error: `No handler registered for job kind '${job.kind}'` };
    try {
      await handler(job.payload, job);
      return { ...base, ok: true };
    } catch (error) {
      return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private nextSeq(): number {
    const current = this.store.get<SequenceRecord>(META, 'job-sequence')?.value ?? 0;
    this.store.put<SequenceRecord>(META, { id: 'job-sequence', value: current + 1 });
    return current + 1;
  }
}

function compareJobs(a: ScheduledJob, b: ScheduledJob): number {
  const diff = Date.parse(a.runAt) - Date.parse(b.runAt);
  return diff !== 0 ? diff : a.seq - b.seq;
}
