import { describe, expect, it } from 'vitest';
import { DirectoryQueue, directoriesOverlap } from '../../../src/runtime/directory-queue';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { resolve } from 'node:path';

const cwd = resolve('scheduling-project');
function policy(expiresAt = Date.now() + 100000): RunPolicyAllow { return { ok: true, prompt: 'run', requestedCwd: cwd, cwdRealpath: cwd, accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions', access: { ok: true, reason: 'owner' }, attachments: [], policyFingerprint: 'fp', expiresAt }; }

describe('directory scheduling under contention', () => {
  it('handles directory boundaries instead of raw prefix matches', () => {
    expect(directoriesOverlap(resolve('repo'), resolve('repo/sub'))).toBe(true);
    expect(directoriesOverlap(resolve('repo'), resolve('repo-other'))).toBe(false);
  });
  it('serializes parent and child paths while unrelated paths run concurrently', async () => {
    const queue = new DirectoryQueue(); const releaseA = await queue.acquire(cwd);
    let started = false; const b = queue.acquire(resolve(cwd, 'sub')).then((release) => { started = true; return release; });
    const releaseC = await queue.acquire(resolve('unrelated-project'));
    expect(started).toBe(false); releaseA(); const releaseB = await b; expect(started).toBe(true); releaseB(); releaseC();
  });
  it('cancels a waiter and removes it without blocking later work', async () => {
    const queue = new DirectoryQueue(); const release = await queue.acquire(cwd); const abort = new AbortController();
    const rejected = expect(queue.acquire(cwd, abort.signal)).rejects.toThrow('取消'); abort.abort(); await rejected; release(); (await queue.acquire(cwd))();
  });
  it('reserves pool capacity before waking FIFO waiters', async () => {
    const pool = new ProcessPool(() => 1); const first = await pool.acquire(); const second = pool.acquire(); first();
    expect(pool.tryAcquire()).toBeUndefined(); const release = await second; expect(pool.snapshot().active).toBe(1); release(); expect(pool.snapshot().active).toBe(0);
  });
  it('cancels a process-pool waiter without spawning an agent', async () => {
    const pool = new ProcessPool(() => 1); const release = await pool.acquire(); const agent = new FakeAgentAdapter(); const executor = new RunExecutor({ agent, pool, activeRuns: new ActiveRuns() });
    const rejected = expect(executor.submit({ scopeId: 'waiting', policy: policy() })).rejects.toMatchObject({ code: 'cancelled' });
    await executor.cancel('waiting'); await rejected; release(); expect(agent.runOptions).toHaveLength(0); expect(pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });
  it('rejects a policy that expired while waiting for a pool slot', async () => {
    let now = 1; const pool = new ProcessPool(() => 1); const release = await pool.acquire(); const agent = new FakeAgentAdapter(); const executor = new RunExecutor({ agent, pool, activeRuns: new ActiveRuns(), now: () => now });
    const rejected = expect(executor.submit({ scopeId: 'waiting', policy: policy(2) })).rejects.toMatchObject({ code: 'policy-expired' });
    now = 3; release(); await rejected; expect(agent.runOptions).toHaveLength(0); expect(pool.snapshot().active).toBe(0);
  });
  it('does not spawn when cancellation arrives during the final async preflight', async () => {
    const agent = new FakeAgentAdapter(); const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns() });
    let checks = 0; let unblock!: () => void;
    const waiting = new Promise<void>((resolve) => { unblock = resolve; });
    const rejected = expect(executor.submit({ scopeId: 'late-cancel', policy: policy(), beforeSpawn: async () => { checks++; if (checks === 2) await waiting; } })).rejects.toMatchObject({ code: 'cancelled' });
    while (checks < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    await executor.cancel('late-cancel'); unblock(); await rejected; expect(agent.runOptions).toHaveLength(0);
  });

});
