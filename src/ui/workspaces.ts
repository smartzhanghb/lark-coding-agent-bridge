import type { Controls } from '../commands';
import { changeBinding, workspaceBusy } from '../workspace/service';
import { resolveWorkingDirectory } from '../policy/workspace';
import { HttpError } from './http';

export async function workspaceView(controls: Controls) {
  const rt = controls.workspaceRuntime;
  if (!rt) throw new HttpError(409, '机器人未运行，启动后可管理工作区');
  const projects = await Promise.all(rt.workspaces.projects().map(async (p) => ({ ...p, available: (await resolveWorkingDirectory(p.cwd)).ok })));
  const conversations = new Map(rt.workspaces.conversations().map((c) => [c.id, c]));
  for (const chat of controls.knownChats ?? []) if (!conversations.has(chat.id)) conversations.set(chat.id, { id: chat.id, chatId: chat.id, type: 'group', name: chat.name, lastActivity: 0 });
  for (const id of Object.keys(rt.workspaces.bindings())) if (!conversations.has(id)) conversations.set(id, { id, chatId: id.split(':')[0]!, type: id.includes(':') ? 'topic' : 'group', lastActivity: 0 });
  return {
    managed: controls.profileConfig.workspaces.managedBindings === true,
    projects,
    conversations: [...conversations.values()].map((c) => ({ ...c, ...rt.workspaces.selection(c.id), ownerDefault: c.ownerDm && !rt.workspaces.binding(c.id) && Boolean(controls.profileConfig.workspaces.default), busy: workspaceBusy(rt, c.id), state: rt.executor.snapshot().find((j) => j.scope === c.id)?.state ?? 'idle' })),
  };
}
export async function mutateWorkspace(controls: Controls, value: unknown) {
  const rt = controls.workspaceRuntime;
  if (!rt || !controls.botOwnerId) throw new HttpError(409, '机器人未运行或所有者尚未确认');
  if (!controls.profileConfig.workspaces.managedBindings) throw new HttpError(409, '请先启用 managedBindings 并重启该配置');
  const body = value as Record<string, unknown>;
  if (!body || typeof body !== 'object') throw new HttpError(400, '请求无效');
  const projectMutation = body.action === 'save' || body.action === 'remove';
  if (projectMutation && rt.changing.size) throw new HttpError(409, '正在变更工作区，请稍后重试');
  if (projectMutation) rt.changing.add('*');
  try {
    if (body.action === 'save') {
      const id = typeof body.id === 'string' ? body.id : undefined;
      if (id && rt.workspaces.conversations().some((c) => rt.workspaces.selection(c.id).project?.id === id && workspaceBusy(rt, c.id))) throw new Error('项目仍有运行或排队任务，请先停止任务');
      if (typeof body.name !== 'string' || typeof body.cwd !== 'string') throw new Error('请填写项目名称和目录');
      await rt.workspaces.saveProject({ id, name: body.name, cwd: body.cwd, enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined });
    } else if (body.action === 'remove') {
      if (typeof body.id !== 'string') throw new Error('项目 ID 无效');
      await rt.workspaces.deleteProject(body.id);
    } else if (body.action === 'bind' || body.action === 'unbind' || body.action === 'inherit') {
      if (typeof body.scope !== 'string' || !/^oc_[a-zA-Z0-9_]+(?::[a-zA-Z0-9_]+)?$/.test(body.scope)) throw new Error('聊天 ID 无效');
      if (typeof body.revision !== 'string') throw new Error('缺少绑定版本，请刷新');
      if (body.action === 'bind' && typeof body.projectId !== 'string') throw new Error('请选择项目');
      await changeBinding(rt, { scope: body.scope, projectId: body.action === 'bind' ? body.projectId as string : undefined, revision: body.revision, stop: body.stop === true, inherit: body.action === 'inherit' });
    } else throw new Error('未知操作');
  } catch (err) { throw new HttpError(409, err instanceof Error ? err.message : String(err)); }
  finally { if (projectMutation) rt.changing.delete('*'); }
  return workspaceView(controls);
}
