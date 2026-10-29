import { log } from '../core/logger';
import { selectedWorkspace, selectedModel, generationFingerprint } from '../workspace/selection';
import type { AgentCapability } from '../agent/capability';
import { isDefaultModel, supportedModels, resolveModelArg } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface StartRunFlowInput {
  scopeId: string;
  actorIds?: string[];
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  now: number;
  stopGraceMs?: number;
  ownerDm?: boolean;
  expectedRunVersion?: number;
  recheckAccess?: () => AccessDecision;
  currentProfileConfig?: () => ProfileConfig;
  onQueued?: (position: number) => void;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | 'workspace-unbound'
  | 'model-unavailable'
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
  workspaces?: WorkspaceStore;
  generation?: string;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const managed = input.profileConfig.workspaces.managedBindings === true;
  const runVersion = input.expectedRunVersion ?? input.executor.version(input.scopeId);
  const generation = input.workspaces.generation(input.scopeId);
  const requestedCwd = selectedWorkspace({ ...input, scope: input.scopeId }) ?? '';
  if (managed && !requestedCwd) return { ok: false, rejectReason: { code: 'workspace-unbound', userVisible: '当前聊天未绑定可用项目，请等待机器人所有者绑定或启用工作区。' } };
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  if (managed) policy.policyFingerprint = generationFingerprint(policy.policyFingerprint, generation);
  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (catalogEntry?.agentId === 'claude') {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === 'codex') {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && !managed && input.capability.agentId === 'claude') {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  const model = selectedModel({ ...input, scope: input.scopeId });
  if (!isDefaultModel(model) && !supportedModels(input.profileConfig.agentKind, workspace.cwdRealpath).some((m) => m.value === model)) {
    return { ok: false, rejectReason: { code: 'model-unavailable', userVisible: '工作区模型已不在当前 CLI 配置中，请联系所有者重新选择模型。' } };
  }
  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      actorIds: input.actorIds ?? [input.scope.actorId],
      policy,
      serializeDirectory: managed,
      onQueued: input.onQueued,
      beforeSpawn: async () => {
        let currentProfile = input.currentProfileConfig?.() ?? input.profileConfig;
        if ((input.actorIds ?? [input.scope.actorId]).some((id) => currentProfile.access.blockedUsers?.includes(id)) || input.recheckAccess?.().ok === false) throw new RunRejected('binding-changed', '当前请求无法处理，请联系管理员。');
        if (selectedModel({ ...input, profileConfig: currentProfile, scope: input.scopeId }) !== model || (!isDefaultModel(model) && !supportedModels(currentProfile.agentKind, workspace.cwdRealpath).some((m) => m.value === model))) throw new RunRejected('binding-changed', '模型配置已变化，请重新发送任务。');
        if (!managed) return;
        if (runVersion !== input.executor.version(input.scopeId)) throw new RunRejected('cancelled', '任务已取消');
        if (generation !== input.workspaces.generation(input.scopeId)) throw new RunRejected('binding-changed', '工作区或会话已变化，旧任务已取消，请重新发送');
        const cwd = selectedWorkspace({ ...input, scope: input.scopeId });
        const latest = cwd ? await resolveWorkingDirectory(cwd) : undefined;
        if (!latest?.ok || latest.cwdRealpath !== workspace.cwdRealpath) throw new RunRejected('binding-changed', '工作区已失效，任务未执行');
        currentProfile = input.currentProfileConfig?.() ?? input.profileConfig;
        if ((input.actorIds ?? [input.scope.actorId]).some((id) => currentProfile.access.blockedUsers?.includes(id))) throw new RunRejected('binding-changed', '当前请求无法处理，请联系管理员。');
        const next = evaluateRunPolicy({ ...input, profileConfig: currentProfile, requestedCwd, cwdRealpath: workspace.cwdRealpath, access: input.recheckAccess?.() ?? input.access, now: Date.now(), codexHome: currentProfile.codex?.codexHome, inheritCodexHome: currentProfile.codex?.inheritCodexHome });
        if (runVersion !== input.executor.version(input.scopeId)) throw new RunRejected('cancelled', '任务已取消');
        if (generation !== input.workspaces.generation(input.scopeId)) throw new RunRejected('binding-changed', '工作区或会话已变化，请重新发送');
        if (!next.ok || generationFingerprint(next.policyFingerprint, generation) !== policy.policyFingerprint) throw new RunRejected('binding-changed', '访问权限已变化，请重新发送任务');
        policy.expiresAt = next.expiresAt;
      },
      sessionId,
      threadId,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        model,
        workspace.cwdRealpath,
      ),
      images:
        input.capability.agentId === 'codex'
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'binding-changed' || err.code === 'cancelled' ? err.message : err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (input.workspaces && input.generation !== undefined && input.workspaces.generation(input.scopeId) !== input.generation) return;
  if (input.workspaces && input.event.model) void input.workspaces.recordModel(input.scopeId, input.event.model, input.generation).catch((err) => log.warn('workspace', 'model-record-failed', { err: String(err) }));
  if (input.capability.agentId === 'claude' && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'claude',
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.agentId === 'codex' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}
