import type { ActiveRuns } from '../bot/active-runs';
import type { PendingQueue } from '../bot/pending-queue';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionStore } from '../session/store';
import type { SessionCatalog } from '../session/catalog';
import type { WorkspaceStore } from './store';

export interface WorkspaceRuntime {
  workspaces: WorkspaceStore;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  executor: RunExecutor;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  /** Binding mutations and resets run one at a time with intake paused per affected chat. */
  changing: Set<string>;
}
export function affectedScope(target: string, scope: string): boolean { return scope === target || scope.startsWith(`${target}:`); }
export function workspaceBusy(rt: WorkspaceRuntime, scope: string): boolean {
  return rt.executor.snapshot().some((j) => affectedScope(scope, j.scope)) || rt.pending.scopes().some((s) => affectedScope(scope, s));
}
export async function changeBinding(rt: WorkspaceRuntime, input: {
  scope: string; projectId?: string; revision: string; stop?: boolean; inherit?: boolean;
}): Promise<void> {
  const { scope } = input;
  if (rt.changing.size) throw new Error('正在变更工作区，请稍后重试');
  rt.changing.add(scope);
  try {
    if (rt.workspaces.generation(scope) !== input.revision) throw new Error('绑定已变化，请刷新后重试');
    if (workspaceBusy(rt, scope) && !input.stop) throw new Error('该聊天有运行或排队任务，请先停止任务，或选择“停止任务并切换”');
    for (const s of rt.pending.scopes()) if (affectedScope(scope, s)) rt.pending.cancel(s);
    for (const j of rt.executor.snapshot()) if (affectedScope(scope, j.scope)) await rt.executor.cancel(j.scope);
    // A queued cancellation removes its controller asynchronously; generation checks
    // still invalidate it before spawn. Running processes must have exited above.
    if (input.inherit) await rt.workspaces.inherit(scope, input.revision);
    else await rt.workspaces.bind(scope, input.projectId, input.revision);
    for (const s of new Set([scope, ...rt.workspaces.conversations().map((c) => c.id)])) {
      if (!affectedScope(scope, s)) continue;
      rt.sessions.clear(s);
      for (const entry of rt.sessionCatalog?.entries() ?? []) if (entry.scopeId === s && entry.status === 'active') rt.sessionCatalog?.archiveActive(entry);
    }
    await Promise.all([rt.sessions.flush(), rt.sessionCatalog?.flush()]);
  } finally { rt.changing.delete(scope); }
}
