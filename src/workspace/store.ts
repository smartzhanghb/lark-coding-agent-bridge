import { copyFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validModelId } from '../agent/models';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveWorkingDirectory } from '../policy/workspace';

export interface ProjectWorkspace {
  id: string;
  name: string;
  cwd: string;
  enabled: boolean;
  /** undefined inherits the profile; default follows the CLI. */
  model?: string;
}
export interface WorkspaceBinding { projectId?: string; revision: number; blocked?: boolean }
export interface Conversation {
  id: string;
  chatId: string;
  type: 'p2p' | 'group' | 'topic';
  name?: string;
  lastActivity: number;
  ownerDm?: boolean;
  actualModel?: string;
}
interface WorkspaceData {
  schemaVersion: 2;
  chats: Record<string, { cwd: string }>;
  named: Record<string, string>;
  projects: Record<string, ProjectWorkspace>;
  bindings: Record<string, WorkspaceBinding>;
  conversations: Record<string, Conversation>;
  epochs: Record<string, number>;
}
const empty = (): WorkspaceData => ({ schemaVersion: 2, chats: {}, named: {}, projects: {}, bindings: {}, conversations: {}, epochs: {} });

/** One writer per profile. Managed mutations publish only after atomic disk commit. */
export class WorkspaceStore {
  private data = empty();
  private saving: Promise<void> = Promise.resolve();
  private persistError: unknown;
  constructor(private readonly path: string = paths.workspacesFile) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Partial<WorkspaceData>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作区数据格式无效');
      if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2) throw new Error('不支持的工作区数据版本，请先核对备份');
      for (const field of ['chats', 'named', 'projects', 'bindings', 'conversations', 'epochs'] as const) {
        const value = raw[field];
        if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`工作区字段无效：${field}`);
      }
      for (const value of Object.values(raw.chats ?? {})) if (!value || typeof value.cwd !== 'string') throw new Error('历史目录数据无效');
      for (const value of Object.values(raw.named ?? {})) if (typeof value !== 'string') throw new Error('历史目录别名无效');
      for (const [id, value] of Object.entries(raw.projects ?? {})) if (!value || value.id !== id || typeof value.name !== 'string' || typeof value.cwd !== 'string' || typeof value.enabled !== 'boolean' || (value.model !== undefined && (typeof value.model !== 'string' || !validModelId(value.model)))) throw new Error('项目数据无效');
      for (const value of Object.values(raw.epochs ?? {})) if (!Number.isSafeInteger(value) || value < 0) throw new Error('会话代次无效');
      for (const value of Object.values(raw.bindings ?? {})) if (!value || !Number.isSafeInteger(value.revision) || (value.projectId !== undefined && typeof value.projectId !== 'string')) throw new Error('绑定数据无效');
      for (const value of Object.values(raw.conversations ?? {})) if (!value || typeof value.id !== 'string' || typeof value.chatId !== 'string' || !['p2p', 'group', 'topic'].includes(value.type)) throw new Error('会话目录数据无效');
      this.data = { ...empty(), ...raw, schemaVersion: 2 };
      if (raw.schemaVersion !== 2) {
        await copyFile(this.path, `${this.path}.pre-v2`, 1).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
        // Legacy cwd records are historical evidence, not authorization to run.
        for (const cwd of new Set([...Object.values(raw.chats ?? {}).map((v) => v.cwd), ...Object.values(raw.named ?? {})])) {
          const id = randomUUID();
          this.data.projects[id] = { id, name: `历史目录 ${Object.keys(this.data.projects).length + 1}`, cwd, enabled: true };
        }
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  cwdFor(scope: string): string | undefined { return this.data.chats[scope]?.cwd; }
  setCwd(scope: string, cwd: string): void { this.data.chats[scope] = { cwd }; this.schedulePersist(); }
  removeCwd(scope: string): boolean {
    if (!this.data.chats[scope]) return false;
    delete this.data.chats[scope]; this.schedulePersist(); return true;
  }
  listCwds(prefix?: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.data.chats).filter(([key]) => !prefix || key.startsWith(prefix)).map(([key, v]) => [key, v.cwd]));
  }
  listNamed(): Record<string, string> { return { ...this.data.named }; }
  getNamed(name: string): string | undefined { return this.data.named[name]; }
  saveNamed(name: string, cwd: string): void { this.data.named[name] = cwd; this.schedulePersist(); }
  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name]; this.schedulePersist(); return true;
  }
  projects(): ProjectWorkspace[] { return structuredClone(Object.values(this.data.projects)); }
  conversations(): Conversation[] { return structuredClone(Object.values(this.data.conversations)); }
  bindings(): Record<string, WorkspaceBinding> { return structuredClone(this.data.bindings); }
  project(idOrName: string): ProjectWorkspace | undefined {
    const value = (Object.hasOwn(this.data.projects, idOrName) ? this.data.projects[idOrName] : undefined) ?? Object.values(this.data.projects).find((p) => p.name === idOrName);
    return value ? { ...value } : undefined;
  }
  binding(scope: string): WorkspaceBinding | undefined {
    return this.data.bindings[scope] ?? this.data.bindings[scope.split(':')[0] ?? scope];
  }
  selection(scope: string): { project?: ProjectWorkspace; source: 'direct' | 'inherited' | 'unbound'; revision: string } {
    const direct = this.data.bindings[scope];
    const parent = scope.split(':')[0] ?? scope;
    const binding = direct ?? this.data.bindings[parent];
    return { project: binding?.projectId ? this.project(binding.projectId) : undefined,
      source: direct ? 'direct' : binding ? 'inherited' : 'unbound', revision: this.generation(scope) };
  }
  generation(scope: string): string {
    const parent = scope.split(':')[0] ?? scope;
    return `${this.data.epochs[parent] ?? 0}:${this.data.epochs[scope] ?? 0}`;
  }
  async reset(scope: string): Promise<void> {
    await this.mutate((d) => { d.epochs[scope] = (d.epochs[scope] ?? 0) + 1; });
  }
  async observe(conversation: Conversation): Promise<void> {
    await this.mutate((d) => { d.conversations[conversation.id] = { ...d.conversations[conversation.id], ...conversation }; });
  }
  async recordModel(scope: string, model: string, generation?: string): Promise<void> {
    await this.mutate((d) => {
      if (generation !== undefined && generation !== this.generation(scope)) return;
      if (d.conversations[scope]) d.conversations[scope].actualModel = model;
    });
  }
  async saveProject(input: { id?: string; name: string; cwd: string; enabled?: boolean; model?: string | null }): Promise<ProjectWorkspace> {
    if (input.model != null && !validModelId(input.model)) throw new Error('模型 ID 无效');
    if (!isAbsolute(input.cwd)) throw new Error('请使用绝对目录路径');
    const name = input.name.trim();
    if (!name || name.length > 100) throw new Error('项目名称需为 1–100 个字符');
    const resolved = await resolveWorkingDirectory(input.cwd);
    const previous = input.id ? this.project(input.id) : undefined;
    if (!resolved.ok && (!previous || previous.cwd !== input.cwd)) throw new Error(resolved.userVisible);
    const targetCwd = resolved.ok ? resolved.cwdRealpath : previous!.cwd;
    let result!: ProjectWorkspace;
    await this.mutate((d) => {
      if (Object.values(d.projects).some((p) => p.name === name && p.id !== input.id)) throw new Error('项目名称已存在');
      if (input.id && !d.projects[input.id]) throw new Error('项目不存在');
      const prev = input.id ? d.projects[input.id] : undefined;
      if (prev && prev.cwd !== targetCwd && Object.values(d.bindings).some((b) => b.projectId === prev.id)) throw new Error('项目已绑定聊天，请先解绑再更换目录');
      const id = input.id ?? randomUUID();
      result = { id, name, cwd: targetCwd, enabled: input.enabled ?? prev?.enabled ?? true };
      const model = input.model === null ? undefined : input.model ?? prev?.model;
      if (model !== undefined) result.model = model;
      d.projects[id] = result;
      if (prev?.enabled !== result.enabled || prev?.model !== result.model) for (const [scope, b] of Object.entries(d.bindings)) {
        if (b.projectId === id) {
          d.epochs[scope] = (d.epochs[scope] ?? 0) + 1;
          for (const c of Object.values(d.conversations)) if (c.id === scope || c.id.startsWith(`${scope}:`)) delete c.actualModel;
        }
      }
    });
    return { ...result };
  }
  async deleteProject(id: string): Promise<void> {
    await this.mutate((d) => {
      if (!d.projects[id]) throw new Error('项目不存在');
      if (Object.values(d.bindings).some((b) => b.projectId === id)) throw new Error('请先解绑引用此项目的聊天');
      delete d.projects[id];
    });
  }
  async bind(scope: string, projectId: string | undefined, expectedRevision: string): Promise<void> {
    await this.mutate((d) => {
      if (this.generation(scope) !== expectedRevision) throw new Error('绑定已变化，请刷新后重试');
      if (projectId && !d.projects[projectId]?.enabled) throw new Error('项目不存在或已停用');
      d.epochs[scope] = (d.epochs[scope] ?? 0) + 1;
      for (const c of Object.values(d.conversations)) if (c.id === scope || c.id.startsWith(`${scope}:`)) delete c.actualModel;
      // An explicit unbind blocks topic inheritance and owner-default fallback.
      d.bindings[scope] = { projectId, blocked: !projectId, revision: d.epochs[scope]! };
    });
  }
  async inherit(scope: string, expectedRevision: string): Promise<void> {
    if (!scope.includes(':')) throw new Error('只有话题可设置为继承群工作区');
    await this.mutate((d) => {
      if (this.generation(scope) !== expectedRevision) throw new Error('绑定已变化，请刷新后重试');
      if (d.conversations[scope]) delete d.conversations[scope].actualModel;
      delete d.bindings[scope]; d.epochs[scope] = (d.epochs[scope] ?? 0) + 1;
    });
  }
  async flush(): Promise<void> { await this.saving; if (this.persistError) throw this.persistError; }
  private async mutate(fn: (draft: WorkspaceData) => void): Promise<void> {
    const task = this.saving.then(async () => {
      const draft = structuredClone(this.data); fn(draft);
      await writeFileAtomic(this.path, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      this.data = draft; this.persistError = undefined;
    });
    this.saving = task.catch((err: unknown) => { this.persistError = err; });
    await task;
  }
  private schedulePersist(): void {
    this.saving = this.saving.then(async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 }); this.persistError = undefined;
    }).catch((err: unknown) => { this.persistError = err; log.fail('workspace', err, { step: 'persist' }); });
  }
}
