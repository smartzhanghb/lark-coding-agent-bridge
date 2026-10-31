import { log, reportMetric } from '../core/logger';

interface Waiter { resolve: (release: () => void) => void; reject: (err: Error) => void; signal?: AbortSignal; abort: () => void }
/** FIFO slots are reserved before a waiter wakes; cancellation never leaks a slot. */
export class ProcessPool {
  private active = 0;
  private waiters: Waiter[] = [];
  constructor(private cap: () => number) {}
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('任务已取消')); return; }
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('任务已取消')); this.drain();
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter); this.drain();
    });
  }
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.cap() || this.waiters.length) return undefined;
    return this.grant();
  }
  private grant(): () => void {
    this.active++; reportMetric('pool_active', this.active);
    log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
    let released = false;
    return () => {
      if (released) return; released = true;
      this.active--; reportMetric('pool_active', this.active);
      log.info('pool', 'released', { active: this.active }); this.drain();
    };
  }
  private drain(): void {
    while (this.active < this.cap() && this.waiters.length) {
      const next = this.waiters.shift()!;
      next.signal?.removeEventListener('abort', next.abort);
      next.resolve(this.grant());
    }
  }
  snapshot(): { active: number; waiting: number; cap: number } { return { active: this.active, waiting: this.waiters.length, cap: this.cap() }; }
}
