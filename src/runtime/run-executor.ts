import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';
import { hostDirectoryQueue } from './directory-queue';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  serializeDirectory?: boolean;
  beforeSpawn?: () => Promise<void>;
  onQueued?: (position: number) => void;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private cancellationVersions = new Map<string, number>();
  version(scope: string): number { return this.cancellationVersions.get(scope) ?? 0; }
  private jobs = new Map<string, { controller: AbortController; cwd: string; state: 'queued' | 'running'; stop?: () => Promise<void> }>();
  snapshot() { return [...this.jobs].map(([scope, job]) => ({ scope, cwd: job.cwd, state: job.state })); }
  async cancel(scope: string): Promise<boolean> {
    this.cancellationVersions.set(scope, this.version(scope) + 1);
    const job = this.jobs.get(scope);
    if (!job) return false;
    job.controller.abort();
    if (job.stop) await job.stop();
    return true;
  }
  async cancelAll(): Promise<void> { await Promise.all([...this.jobs.keys()].map((scope) => this.cancel(scope))); }


  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    if (this.jobs.has(input.scopeId)) throw new RunRejected('run-already-active', '上一任务尚未确认退出');
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const controller = new AbortController();
    const job: { controller: AbortController; cwd: string; state: 'queued' | 'running'; stop?: () => Promise<void> } = { controller, cwd: input.policy.cwdRealpath, state: 'queued' };
    this.jobs.set(input.scopeId, job);
    input.onQueued?.([...this.jobs.values()].filter((j) => j.state === 'queued' && j.cwd === job.cwd).length);
    let releaseDirectory: (() => void) | undefined;
    let releasePool: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return; released = true;
      releasePool?.(); releaseDirectory?.(); releaseScope();
      if (this.jobs.get(input.scopeId) === job) this.jobs.delete(input.scopeId);
    };
    try {
      if (input.serializeDirectory && !input.nowait) releaseDirectory = await hostDirectoryQueue.acquire(input.policy.cwdRealpath, controller.signal);
      releasePool = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire(controller.signal);
      if (!releasePool) throw new RunRejected('pool-full', 'process pool is full');
      if (controller.signal.aborted) throw new RunRejected('cancelled', '任务已取消');
      if (this.activeRuns.newRunsPaused()) throw new RunRejected('reconnect-in-progress', '正在重连');
      await input.beforeSpawn?.();
      if (controller.signal.aborted) throw new RunRejected('cancelled', '任务已取消');
      if (input.policy.expiresAt <= this.now()) throw new RunRejected('policy-expired', '运行权限已过期，请重新发送任务');
    } catch (err) {
      release();
      if (controller.signal.aborted) throw new RunRejected('cancelled', '任务已取消');
      throw err;
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    try {
      if (controller.signal.aborted) throw new RunRejected('cancelled', '任务已取消');
      await input.beforeSpawn?.();
      if (controller.signal.aborted) throw new RunRejected('cancelled', '任务已取消');
      if (input.policy.expiresAt <= this.now()) throw new RunRejected('policy-expired', '运行权限已过期');
    } catch (err) { release(); throw err; }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaned = false;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      if (waitForExit) {
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (!exited) {
          log.warn('run', 'post-done-exit-timeout', {
            ...dimensions,
            graceMs: this.postDoneExitGraceMs,
          });
          await run.stop().catch((err) => {
            log.warn('run', 'post-done-stop-failed', {
              ...dimensions,
              err: err instanceof Error ? err.message : String(err),
            });
          });
          if (!await run.waitForExit(this.postDoneExitGraceMs)) {
            // Keep the directory reserved when exit cannot be proven.
            log.warn('run', 'exit-unconfirmed', dimensions); cleaned = false; return;
          }
        }
      }
      this.activeRuns.unregister(input.scopeId, run);
      release();
    };
    job.state = 'running';
    const stop = async () => {
      handle.interrupted = true;
      await run.stop();
      const exited = await run.waitForExit(this.postDoneExitGraceMs);
      if (!exited) throw new Error('子进程尚未退出，不能切换工作区');
      await cleanup(false);
    };
    job.stop = stop;
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(true);
    });

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop,
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
