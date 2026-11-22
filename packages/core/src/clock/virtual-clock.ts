import type { Store } from '../store/store.js';
import type { Scheduler, ScheduledJobResult } from './scheduler.js';

export interface VirtualClock {
  now(): Date;
  advanceBy(options: { readonly milliseconds: number }): Promise<readonly ScheduledJobResult[]>;
  advanceTo(at: Date): Promise<readonly ScheduledJobResult[]>;
  freeze(at?: Date): void;
  unfreeze(): void;
  isFrozen(): boolean;
  /** Runs every job that is due at the current virtual time. */
  runDue(): Promise<readonly ScheduledJobResult[]>;
}

export interface ClockState {
  readonly id: 'clock';
  readonly mode: 'running' | 'frozen';
  /** Running mode: virtual time = wall time + offset. */
  readonly offsetMs: number;
  /** Frozen mode: the fixed virtual time. */
  readonly frozenAt: string | null;
}

const META = 'meta';

/**
 * The only source of time in the sandbox. Runs on wall time plus an offset, or frozen.
 * Advancing walks through due jobs in order, setting the clock to each job's run time
 * so events carry realistic timestamps.
 */
export class SandboxClock implements VirtualClock {
  private state: ClockState;
  private queue: Promise<unknown> = Promise.resolve();
  private scheduler: Scheduler | undefined;

  constructor(
    private readonly store: Store,
    private readonly wallNow: () => number = Date.now,
  ) {
    this.state = this.load();
  }

  attach(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  /** Re-read persisted state (after a snapshot restore or reset). */
  reload(): void {
    this.state = this.load();
  }

  now(): Date {
    if (this.state.mode === 'frozen' && this.state.frozenAt) return new Date(this.state.frozenAt);
    return new Date(this.wallNow() + this.state.offsetMs);
  }

  isFrozen(): boolean {
    return this.state.mode === 'frozen';
  }

  freeze(at?: Date): void {
    this.save({ id: 'clock', mode: 'frozen', offsetMs: 0, frozenAt: (at ?? this.now()).toISOString() });
  }

  unfreeze(): void {
    const current = this.now();
    this.save({ id: 'clock', mode: 'running', offsetMs: current.getTime() - this.wallNow(), frozenAt: null });
  }

  advanceBy(options: { readonly milliseconds: number }): Promise<readonly ScheduledJobResult[]> {
    if (!Number.isFinite(options.milliseconds) || options.milliseconds < 0) {
      return Promise.reject(new Error('advanceBy requires a non-negative number of milliseconds'));
    }
    return this.exclusive(() => this.walkTo(new Date(this.now().getTime() + options.milliseconds)));
  }

  advanceTo(at: Date): Promise<readonly ScheduledJobResult[]> {
    return this.exclusive(async () => {
      if (at.getTime() < this.now().getTime()) throw new Error('The virtual clock cannot move backwards');
      return this.walkTo(at);
    });
  }

  runDue(): Promise<readonly ScheduledJobResult[]> {
    return this.exclusive(async () => {
      const results: ScheduledJobResult[] = [];
      const scheduler = this.requireScheduler();
      for (let job = scheduler.nextDue(this.now()); job; job = scheduler.nextDue(this.now())) {
        results.push(await scheduler.run(job));
      }
      return results;
    });
  }

  private async walkTo(target: Date): Promise<ScheduledJobResult[]> {
    const scheduler = this.requireScheduler();
    const results: ScheduledJobResult[] = [];
    for (let job = scheduler.nextDue(target); job; job = scheduler.nextDue(target)) {
      const runAt = new Date(job.runAt);
      if (runAt.getTime() > this.now().getTime()) this.setTime(runAt);
      results.push(await scheduler.run(job));
    }
    if (target.getTime() > this.now().getTime()) this.setTime(target);
    return results;
  }

  private setTime(at: Date): void {
    if (this.state.mode === 'frozen') {
      this.save({ ...this.state, frozenAt: at.toISOString() });
    } else {
      this.save({ ...this.state, offsetMs: at.getTime() - this.wallNow() });
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireScheduler(): Scheduler {
    if (!this.scheduler) throw new Error('Clock has no scheduler attached');
    return this.scheduler;
  }

  private load(): ClockState {
    return this.store.get<ClockState>(META, 'clock') ?? { id: 'clock', mode: 'running', offsetMs: 0, frozenAt: null };
  }

  private save(state: ClockState): void {
    this.state = state;
    this.store.put(META, state);
  }
}
