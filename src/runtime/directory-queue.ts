import { relative, isAbsolute } from 'node:path';

export function directoriesOverlap(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const r = relative(parent, child);
    return r === '' || (r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(r));
  };
  return contains(a, b) || contains(b, a);
}
interface Waiter { cwd: string; resolve: (release: () => void) => void; reject: (err: Error) => void; signal?: AbortSignal; abort: () => void }
/** Shared by all profile executors in this host process. Unrelated paths may run concurrently. */
export class DirectoryQueue {
  private active = new Set<string>();
  private waiting: Waiter[] = [];
  acquire(cwd: string, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('任务已取消')); return; }
      const waiter: Waiter = { cwd, resolve, reject, signal, abort: () => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(new Error('任务已取消')); this.drain();
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter); this.drain();
    });
  }
  private drain(): void {
    for (const waiter of [...this.waiting]) {
      if ([...this.active].some((cwd) => directoriesOverlap(cwd, waiter.cwd))) continue;
      const preceding = this.waiting.slice(0, this.waiting.indexOf(waiter));
      if (preceding.some((w) => directoriesOverlap(w.cwd, waiter.cwd))) continue;
      this.waiting = this.waiting.filter((w) => w !== waiter);
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.active.add(waiter.cwd);
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; this.active.delete(waiter.cwd); this.drain(); });
    }
  }
}
export const hostDirectoryQueue = new DirectoryQueue();
