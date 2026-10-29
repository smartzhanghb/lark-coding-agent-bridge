import { startUiServer } from '../../../src/ui/server';
import { mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../../src/workspace/store';
import { selectedWorkspace } from '../../../src/workspace/selection';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/bot/active-runs';
import type { NormalizedMessage as QueueMessage } from '@larksuite/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { ProcessPool } from '../../../src/bot/process-pool';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { claudeCapability } from '../../../src/agent/capability';
import { startRunFlow, recordRunSessionEvent } from '../../../src/bot/run-flow';
import { tryHandleCommand, runCommandHandler, type CommandContext } from '../../../src/commands';
import { changeBinding } from '../../../src/workspace/service';
import { mutateWorkspace, workspaceView } from '../../../src/ui/workspaces';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });
async function harness() {
  const tmp = await createTmpProfile(); cleanups.push(tmp.cleanup);
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const profileConfig = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'test-secret', tenant: 'feishu' } } });
  profileConfig.workspaces = { managedBindings: true, default: tmp.workspace };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter({ id: 'claude', events: [{ type: 'system', sessionId: 'recorded' }, { type: 'done', terminationReason: 'normal' }] });
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 10), activeRuns });
  const rt = { workspaces, sessions, sessionCatalog, activeRuns, executor, pending: new PendingQueue(10000, () => {}), changing: new Set<string>() };
  const project = await workspaces.saveProject({ name: '项目 A', cwd: tmp.workspace });
  const run = (scope = 'oc_group', extra: Partial<Parameters<typeof startRunFlow>[0]> = {}) => startRunFlow({
    scopeId: scope, scope: { source: 'im', chatId: scope.split(':')[0], actorId: 'ou_user' }, prompt: 'run', attachments: [],
    access: { ok: true, reason: 'allowed-user' }, capability: claudeCapability(profileConfig), profileConfig, sessions, sessionCatalog, workspaces, executor, now: Date.now(), ...extra,
  });
  const channel = createFakeChannel();
  const ctx = (senderId = 'ou_owner'): CommandContext => ({
    channel: channel as unknown as LarkChannel,
    msg: { chatId: 'oc_group', senderId, content: '', resources: [], mentions: [], chatType: 'group', messageId: 'm', rawContentType: 'text', mentionedBot: true, mentionAll: false, createTime: Date.now() } as NormalizedMessage,
    scope: 'oc_group', chatMode: 'group', sessions, sessionCatalog, workspaces, agent, activeRuns, runExecutor: executor,
    controls: { profile: 'claude', profileConfig, botOwnerId: 'ou_owner', ownerRefreshState: 'ok', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {}, configPath: join(tmp.profile, 'config.json'), cfg: { preferences: {} } as never, processId: 'test', workspaceRuntime: rt },
  });
  return { tmp, workspaces, profileConfig, project, sessions, sessionCatalog, executor, agent, run, rt, ctx, channel };
}
async function drain(execution: { subscribe(): AsyncIterable<unknown> }) { for await (const _ of execution.subscribe()) { /* drain */ } }

describe('managed workspace bindings', () => {
  it('round-trips per-project model ids, forwards exact args, and resets inherited sessions', async () => {
    const h = await harness();
    const modelDir = join(h.tmp.profile, 'claude-models'); await mkdir(modelDir);
    await writeFile(join(modelDir, 'settings.json'), JSON.stringify({ modelPicker: { options: [{ model: 'glm[1M]', label: 'GLM' }, { model: 'kimi', label: 'Kimi' }] } }));
    vi.stubEnv('CLAUDE_CONFIG_DIR', modelDir);
    try {
      await h.workspaces.saveProject({ ...h.project, model: 'glm[1M]' });
      await h.workspaces.bind('oc_group', h.project.id, '0:0');
      const r = await h.run('oc_group:topic'); expect(r.ok).toBe(true); if (r.ok) await drain(r.execution);
      expect(h.agent.runOptions[0]?.model).toBe('glm[1M]');
      const generation = h.workspaces.generation('oc_group:topic');
      await h.workspaces.saveProject({ ...h.project, model: 'kimi' });
      expect(h.workspaces.generation('oc_group:topic')).not.toBe(generation);
      const r2 = await h.run('oc_group:topic'); expect(r2.ok).toBe(true); if (r2.ok) await drain(r2.execution);
      expect(h.agent.runOptions[1]?.model).toBe('kimi');
      expect(h.agent.runOptions[1]?.sessionId).toBeUndefined();
      const reopened = new WorkspaceStore(join(h.tmp.profile, 'workspaces.json')); await reopened.load();
      expect(reopened.project(h.project.id)?.model).toBe('kimi');
      await writeFile(join(modelDir, 'settings.json'), '{}');
      expect(await h.run()).toMatchObject({ ok: false, rejectReason: { code: 'model-unavailable' } });
      expect(h.agent.runOptions).toHaveLength(2);
      await h.workspaces.saveProject({ ...h.project, model: null });
      expect(h.workspaces.project(h.project.id)?.model).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it('cancels a merged request if any actor becomes blocked before spawn', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    h.profileConfig.access.blockedUsers = ['ou_bad'];
    const r = await h.run('oc_group', { actorIds: ['ou_user', 'ou_bad'] });
    expect(r.ok).toBe(false); expect(h.agent.runOptions).toHaveLength(0);
  });
  it('records CLI model reports only for the current binding generation', async () => {
    const h = await harness(); await h.workspaces.observe({ id: 'oc_group', chatId: 'oc_group', type: 'group', lastActivity: 1 });
    await h.workspaces.bind('oc_group', h.project.id, '0:0');
    const old = h.workspaces.generation('oc_group');
    await h.workspaces.recordModel('oc_group', 'glm-actual', old);
    expect((await workspaceView(h.ctx().controls)).conversations[0]?.actualModel).toBe('glm-actual');
    await h.workspaces.saveProject({ ...h.project, model: 'default' });
    await h.workspaces.recordModel('oc_group', 'stale-model', old);
    expect(h.workspaces.conversations()[0]?.actualModel).toBeUndefined();
  });
  it('removes only the blocked sender from a pending merged batch', () => {
    const queue = new PendingQueue(10000, () => {});
    queue.push('group', { senderId: 'ou_bad' } as QueueMessage);
    queue.push('group', { senderId: 'ou_good' } as QueueMessage);
    queue.push('private', { senderId: 'ou_bad' } as QueueMessage);
    queue.removeSender('ou_bad');
    expect(queue.scopes()).toEqual(['group']);
    expect(queue.cancel('group').map((m) => m.senderId)).toEqual(['ou_good']);
  });
  it('blocks unbound coworker chats and limits default fallback to the owner DM', async () => {
    const h = await harness();
    expect(await h.run()).toMatchObject({ ok: false, rejectReason: { code: 'workspace-unbound' } });
    expect(selectedWorkspace({ ...h, scope: 'oc_group', ownerDm: false })).toBeUndefined();
    const r = await h.run('oc_owner', { ownerDm: true }); expect(r.ok).toBe(true); if (r.ok) await drain(r.execution);
    await h.workspaces.bind('oc_owner', undefined, h.workspaces.generation('oc_owner'));
    expect((await h.run('oc_owner', { ownerDm: true })).ok).toBe(false);
  });
  it('inherits group bindings, supports topic overrides and explicit unbind', async () => {
    const h = await harness();
    await h.workspaces.bind('oc_group', h.project.id, '0:0');
    expect(h.workspaces.selection('oc_group:topic').source).toBe('inherited');
    await h.workspaces.bind('oc_group:topic', undefined, h.workspaces.generation('oc_group:topic'));
    expect((await h.run('oc_group:topic')).ok).toBe(false);
    await h.workspaces.inherit('oc_group:topic', h.workspaces.generation('oc_group:topic'));
    expect(h.workspaces.selection('oc_group:topic').project?.id).toBe(h.project.id);
  });
  it('does not fall back when the bound directory disappears or is disabled', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    await h.workspaces.saveProject({ ...h.project, enabled: false });
    expect((await h.run()).ok).toBe(false);
    await h.workspaces.saveProject({ ...h.project, enabled: true });
    await rename(h.tmp.workspace, `${h.tmp.workspace}-moved`);
    expect((await h.run()).ok).toBe(false); expect(h.agent.runOptions).toHaveLength(0);
  });
  it('keeps stable ids on rename, rejects duplicate names and deletion while referenced', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    const renamed = await h.workspaces.saveProject({ ...h.project, name: '新名称' });
    expect(renamed.id).toBe(h.project.id);
    expect(h.workspaces.selection('oc_group').project?.name).toBe('新名称');
    await expect(h.workspaces.saveProject({ name: '新名称', cwd: h.tmp.workspace })).rejects.toThrow('已存在');
    await expect(h.workspaces.deleteProject(h.project.id)).rejects.toThrow('解绑');
  });
  it('round-trips bindings and rejects stale revisions', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    await expect(h.workspaces.bind('oc_group', undefined, '0:0')).rejects.toThrow('已变化');
    const reopened = new WorkspaceStore(join(h.tmp.profile, 'workspaces.json')); await reopened.load();
    expect(reopened.selection('oc_group')).toEqual(h.workspaces.selection('oc_group'));
  });
  it('does not publish a successful binding when disk commit fails', async () => {
    const h = await harness(); const path = join(h.tmp.profile, 'workspaces.json');
    await rename(path, `${path}.saved`); await mkdir(path);
    await expect(h.workspaces.bind('oc_group', h.project.id, '0:0')).rejects.toThrow();
    expect(h.workspaces.binding('oc_group')).toBeUndefined(); expect(h.workspaces.generation('oc_group')).toBe('0:0');
  });
  it('backs up legacy data without authorizing the historical cwd', async () => {
    const h = await harness(); const path = join(h.tmp.profile, 'legacy.json');
    const raw = JSON.stringify({ chats: { oc_legacy: { cwd: h.tmp.workspace } }, named: { main: h.tmp.workspace } });
    await writeFile(path, raw); const store = new WorkspaceStore(path); await store.load();
    expect(await readFile(`${path}.pre-v2`, 'utf8')).toBe(raw);
    expect(store.projects()).toHaveLength(1); expect(store.selection('oc_legacy').project).toBeUndefined();
    expect(store.cwdFor('oc_legacy')).toBe(h.tmp.workspace);
  });
  it('starts fresh on A→B→A and ignores stale session events', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    const oldGeneration = h.workspaces.generation('oc_group');
    const first = await h.run(); expect(first.ok).toBe(true); if (!first.ok) return;
    recordRunSessionEvent({ scopeId: 'oc_group', sessions: h.sessions, sessionCatalog: h.sessionCatalog, capability: claudeCapability(h.profileConfig), policy: first.policy, event: { type: 'system', sessionId: 'private-A' }, workspaces: h.workspaces, generation: oldGeneration });
    await drain(first.execution);
    const b = join(h.tmp.root, 'B'); await mkdir(b); const p = await h.workspaces.saveProject({ name: 'B', cwd: b });
    await changeBinding(h.rt, { scope: 'oc_group', projectId: p.id, revision: h.workspaces.generation('oc_group') });
    await changeBinding(h.rt, { scope: 'oc_group', projectId: h.project.id, revision: h.workspaces.generation('oc_group') });
    recordRunSessionEvent({ scopeId: 'oc_group', sessions: h.sessions, sessionCatalog: h.sessionCatalog, capability: claudeCapability(h.profileConfig), policy: first.policy, event: { type: 'system', sessionId: 'late-A' }, workspaces: h.workspaces, generation: oldGeneration });
    expect(h.sessions.getRaw('oc_group')).toBeUndefined();
    const next = await h.run(); expect(next.ok).toBe(true); if (next.ok) { expect(next.resumeFrom).toBeUndefined(); await drain(next.execution); }
  });
  it.each(['/cd /tmp/project', '/ws use 项目 A', '/ws bind 项目 A', '/ws unbind', '/ws save other', '/new chat clone'])('denies non-owner entrypoint %s', async (command) => {
    const h = await harness(); const ctx = h.ctx('ou_admin'); ctx.controls.profileConfig.access.admins = ['ou_admin']; ctx.msg.content = command;
    await tryHandleCommand(ctx);
    expect(JSON.stringify(h.channel.sent)).toContain('仅机器人所有者'); expect(h.workspaces.binding(ctx.scope)).toBeUndefined();
  });
  it('denies legacy card workspace mutations and exposes only the current project to coworkers', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    await runCommandHandler('ws', 'use 项目 A', h.ctx('ou_admin'));
    expect(JSON.stringify(h.channel.sent)).toContain('仅机器人所有者');
    h.channel.sent.splice(0); await runCommandHandler('ws', 'list', h.ctx('ou_user'));
    expect(JSON.stringify(h.channel.sent)).toContain('项目 A'); expect(JSON.stringify(h.channel.sent)).not.toContain(h.project.cwd);
  });
  it('shares one binding service between commands and the UI with stale-request rejection', async () => {
    const h = await harness(); await h.workspaces.observe({ id: 'oc_group', chatId: 'oc_group', type: 'group', lastActivity: Date.now() });
    await mutateWorkspace(h.ctx().controls, { action: 'bind', scope: 'oc_group', projectId: h.project.id, revision: '0:0' });
    expect((await workspaceView(h.ctx().controls)).conversations[0]?.project?.id).toBe(h.project.id);
    await expect(mutateWorkspace(h.ctx().controls, { action: 'unbind', scope: 'oc_group', revision: '0:0' })).rejects.toThrow('已变化');
    await runCommandHandler('ws', 'unbind', h.ctx()); expect(h.workspaces.binding('oc_group')?.blocked).toBe(true);
  });
  it('requires an explicit stop before switching a running conversation', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0'); const run = await h.run(); if (!run.ok) throw new Error('not started');
    await expect(changeBinding(h.rt, { scope: 'oc_group', revision: h.workspaces.generation('oc_group') })).rejects.toThrow('先停止');
    await changeBinding(h.rt, { scope: 'oc_group', revision: h.workspaces.generation('oc_group'), stop: true });
    expect(h.agent.runs[0]?.stopped).toBe(true); expect(h.workspaces.binding('oc_group')?.blocked).toBe(true);
  });
  it('cancels a task waiting for the same directory without ever spawning it', async () => {
    const h = await harness(); for (const scope of ['oc_a', 'oc_b']) await h.workspaces.bind(scope, h.project.id, '0:0');
    const a = await h.run('oc_a'); if (!a.ok) throw new Error('not started');
    const b = h.run('oc_b'); await new Promise((r) => setTimeout(r, 10));
    expect(h.executor.snapshot().find((j) => j.scope === 'oc_b')?.state).toBe('queued');
    await h.executor.cancel('oc_b'); expect(await b).toMatchObject({ ok: false, rejectReason: { code: 'cancelled' } });
    await drain(a.execution); expect(h.agent.runOptions).toHaveLength(1);
  });
  it('rechecks permissions after waiting for a directory', async () => {
    const h = await harness(); for (const scope of ['oc_a', 'oc_b']) await h.workspaces.bind(scope, h.project.id, '0:0');
    const a = await h.run('oc_a'); if (!a.ok) throw new Error('not started');
    let allowed = true;
    const b = h.run('oc_b', { recheckAccess: () => allowed ? { ok: true, reason: 'allowed-user' } : { ok: false, reason: 'denied-user' } });
    await new Promise((r) => setTimeout(r, 10)); allowed = false; await drain(a.execution);
    expect(await b).toMatchObject({ ok: false, rejectReason: { code: 'binding-changed' } }); expect(h.agent.runOptions).toHaveLength(1);
  });
  it('explicitly restores only catalog history belonging to the current chat', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    const r = await h.run(); if (!r.ok) throw new Error('not started');
    h.sessionCatalog.upsertActive({ scopeId: 'oc_group', agentId: 'claude', cwdRealpath: await realpath(h.tmp.workspace), policyFingerprint: r.policy.policyFingerprint, sessionId: 'correct' });
    h.sessionCatalog.upsertActive({ scopeId: 'oc_private', agentId: 'claude', cwdRealpath: await realpath(h.tmp.workspace), policyFingerprint: r.policy.policyFingerprint, sessionId: 'secret' });
    await drain(r.execution); await h.workspaces.reset('oc_group');
    const ctx = h.ctx(); ctx.sessionCatalogIdentity = { scopeId: ctx.scope, agentId: 'claude', cwdRealpath: await realpath(h.tmp.workspace), policyFingerprint: r.policy.policyFingerprint.replace(/:generation=.*/, `:generation=${h.workspaces.generation(ctx.scope)}`) };
    await runCommandHandler('resume', '', ctx);
    const text = JSON.stringify(h.channel.sent); expect((text.match(/resume use/g) ?? [])).toHaveLength(1);
    const token = text.match(/resume use ([a-f0-9-]+)/)?.[1]; expect(token).toBeTruthy();
    await runCommandHandler('resume', `use ${token}`, ctx);
    expect(h.sessions.getRaw(ctx.scope)?.sessionId).toBe('correct');
    const restored = await h.run(); if (!restored.ok) throw new Error('not started'); expect(restored.resumeFrom).toBe('correct'); await drain(restored.execution);
  });
  it('does not disclose the project catalog when the owner requests a list in a group', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    await h.workspaces.saveProject({ name: '不能出现在群里的项目', cwd: h.tmp.workspace });
    await runCommandHandler('ws', 'list', h.ctx());
    expect(JSON.stringify(h.channel.sent)).not.toContain('不能出现在群里的项目');
    expect(JSON.stringify(h.channel.sent)).not.toContain(h.project.cwd);
  });
  it('guards workspace HTTP endpoints and skips maintenance while a task is active', async () => {
    const h = await harness(); const controls = h.ctx().controls; controls.restart = vi.fn(async () => {});
    const server = await startUiServer({ version: 'test', supervisor: {
      isOnline: () => true, controlsFor: () => controls, channelFor: () => undefined, list: () => [], startProfile: async () => {}, stopProfile: async () => {}, restartProfile: async () => {},
    } });
    try {
      const base = `http://127.0.0.1:${server.port}`; const headers = { 'x-ui-token': server.token, 'content-type': 'application/json' };
      expect((await fetch(`${base}/api/workspaces?profile=claude`)).status).toBe(401);
      expect((await fetch(`${base}/api/workspaces?profile=claude`, { headers: { ...headers, origin: 'https://foreign.example' } })).status).toBe(403);
      const bind = await fetch(`${base}/api/workspaces?profile=claude`, { method: 'POST', headers, body: JSON.stringify({ action: 'bind', scope: 'oc_group', projectId: h.project.id, revision: '0:0' }) });
      expect(bind.status).toBe(200); expect((await bind.json() as { projects: unknown[] }).projects).toHaveLength(1);
      const running = await h.run(); if (!running.ok) throw new Error('not started');
      const busy = await fetch(`${base}/api/maintenance/restart-if-idle?profile=claude`, { method: 'POST', headers });
      expect(await busy.json()).toMatchObject({ restarted: false, reason: 'busy' }); expect(controls.restart).not.toHaveBeenCalled();
      await drain(running.execution);
      const idle = await fetch(`${base}/api/maintenance/restart-if-idle?profile=claude`, { method: 'POST', headers });
      expect(await idle.json()).toMatchObject({ restarted: true }); expect(controls.restart).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it('honors a stop received while attachments or prompt preparation are still in progress', async () => {
    const h = await harness(); await h.workspaces.bind('oc_group', h.project.id, '0:0');
    const expectedRunVersion = h.executor.version('oc_group');
    expect(await h.executor.cancel('oc_group')).toBe(false);
    const run = await h.run('oc_group', { expectedRunVersion });
    expect(run).toMatchObject({ ok: false, rejectReason: { code: 'cancelled' } });
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('rejects stale permission policy after the live profile object was replaced', async () => {
    const h = await harness(); for (const scope of ['oc_a', 'oc_b']) await h.workspaces.bind(scope, h.project.id, '0:0');
    const a = await h.run('oc_a'); if (!a.ok) throw new Error('not started');
    let current = h.profileConfig;
    const b = h.run('oc_b', { currentProfileConfig: () => current });
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = { ...h.profileConfig, permissions: { ...h.profileConfig.permissions, defaultAccess: 'read-only' } };
    await drain(a.execution); expect(await b).toMatchObject({ ok: false, rejectReason: { code: 'binding-changed' } });
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('rejects relative project paths rather than resolving them against the daemon cwd', async () => {
    const h = await harness(); await expect(h.workspaces.saveProject({ name: 'relative', cwd: '.' })).rejects.toThrow('绝对');
  });
  it('refuses unsupported state versions without replacing the original file', async () => {
    const h = await harness(); const path = join(h.tmp.profile, 'future.json'); const raw = JSON.stringify({ schemaVersion: 3, projects: {} });
    await writeFile(path, raw); await expect(new WorkspaceStore(path).load()).rejects.toThrow('不支持'); expect(await readFile(path, 'utf8')).toBe(raw);
  });

});
