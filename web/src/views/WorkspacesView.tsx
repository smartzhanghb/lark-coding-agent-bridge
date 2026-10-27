import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Link2, RefreshCw, Plus, MessageSquare, Users, Search, Pencil } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';

type Project = { id: string; name: string; cwd: string; enabled: boolean; available: boolean };
type Conversation = { id: string; name?: string; type: 'p2p' | 'group' | 'topic'; project?: Project; revision: string; source: string; busy: boolean; ownerDefault?: boolean; state: string };
type View = { managed: boolean; projects: Project[]; conversations: Conversation[] };
const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm w-full';
export function WorkspacesView({ profile }: { profile: string }) {
  const [data, setData] = useState<View>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<{ id?: string; name: string; cwd: string; enabled: boolean }>();
  const [bind, setBind] = useState<{ conversation: Conversation; projectId: string; stop: boolean }>();
  const endpoint = `/api/workspaces?profile=${encodeURIComponent(profile)}`;
  const load = useCallback(async () => {
    try { setData(await apiGet<View>(endpoint)); setError(''); } catch (err) { setError((err as Error).message); }
  }, [endpoint]);
  useEffect(() => { setData(undefined); void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function mutate(body: unknown) {
    setSaving(true);
    try { setData(await apiPost<View>(endpoint, body)); setEdit(undefined); setBind(undefined); toast.success('已保存并生效'); }
    catch (err) { toast.error((err as Error).message); await load(); }
    finally { setSaving(false); }
  }
  const rows = data?.conversations.filter((c) => `${c.name ?? ''} ${c.id} ${c.project?.name ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <Card>
    <CardHeader className="flex-row items-start justify-between gap-4">
      <div className="space-y-2"><CardTitle className="flex items-center gap-2"><FolderOpen className="size-5" />项目与会话</CardTitle><p className="text-sm text-muted-foreground">为每个群聊、私聊指定工作目录。话题可继承群项目，也可单独绑定。</p></div>
      <Button variant="outline" size="sm" onClick={load} aria-label="刷新项目与会话"><RefreshCw className="size-4" />刷新</Button>
    </CardHeader>
    <CardContent className="space-y-6">
      {error && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
      {data && !data.managed && <p className="text-sm text-amber-700">此配置尚未启用会话绑定。请在本机配置中启用 managedBindings 后重启。</p>}
      {data && <>
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">工作区 <span className="text-muted-foreground font-normal">{data.projects.length}</span></h3><Button size="sm" disabled={!data.managed || saving} onClick={() => setEdit({ name: '', cwd: '', enabled: true })}><Plus className="size-4" />添加项目</Button></div>
        <div className="grid gap-3 md:grid-cols-2">
          {data.projects.map((p) => <div className="rounded-lg border border-l-4 border-l-primary p-4 space-y-2" key={p.id}>
            <div className="flex items-center gap-2"><span className="font-medium">{p.name}</span><Badge variant={!p.enabled || !p.available ? 'outline' : 'secondary'}>{!p.enabled ? '已停用' : p.available ? '可用' : '目录不可访问'}</Badge><Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={`编辑 ${p.name}`} onClick={() => setEdit(p)}><Pencil className="size-3.5" /></Button></div>
            <p className="text-xs text-muted-foreground break-all font-mono">{p.cwd}</p>
            <div className="flex justify-between items-center"><span className="text-xs text-muted-foreground">{data.conversations.filter((c) => c.project?.id === p.id).length} 个会话使用</span><Button variant="ghost" size="sm" disabled={saving || !data.managed || data.conversations.some((c) => c.project?.id === p.id)} onClick={() => { if (window.confirm(`删除未绑定项目「${p.name}」？本机目录不会被删除。`)) void mutate({ action: 'remove', id: p.id }); }}>删除</Button></div>
          </div>)}
          {!data.projects.length && <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground md:col-span-2">先添加一个本机项目，再把聊天绑定到它。</p>}
        </div>
        <div className="flex flex-wrap gap-3 items-center justify-between border-t pt-5"><h3 className="text-sm font-semibold flex items-center gap-2"><Link2 className="size-4" />会话绑定</h3><div className="relative w-full sm:w-72"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="搜索聊天、ID 或项目" aria-label="搜索会话" value={query} onChange={(e) => setQuery(e.target.value)} /></div></div>
        <div className="divide-y rounded-lg border">
          {rows.map((c) => <div className="flex flex-wrap items-center gap-3 p-4" key={c.id}>
            {c.type === 'p2p' ? <MessageSquare className="size-5 text-muted-foreground" /> : <Users className="size-5 text-muted-foreground" />}
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{c.name || (c.type === 'p2p' ? '私聊' : c.type === 'topic' ? '群聊话题' : '群聊')} <span className="text-xs font-normal text-muted-foreground">{c.source === 'inherited' ? '· 继承群项目' : ''}</span></p><p className="text-xs text-muted-foreground break-all font-mono">{c.id}</p></div>
            <div className="text-right text-sm"><p>{c.project?.name ?? (c.ownerDefault ? '个人默认工作区' : '待绑定')}</p><p className="text-xs text-muted-foreground">{c.state === 'queued' ? '排队中' : c.busy ? '任务处理中' : '空闲'}</p></div>
            <Button variant="outline" size="sm" disabled={saving || !data.managed} onClick={() => setBind({ conversation: c, projectId: c.project?.id ?? '', stop: false })}>配置</Button>
          </div>)}
          {!rows.length && <p className="p-5 text-sm text-muted-foreground">暂无匹配会话。私聊先向机器人发送一条消息，群聊需先将机器人加入。</p>}
        </div>
        <p className="text-xs text-muted-foreground">本页由本机所有者管理。同事仅能查看当前聊天的项目。工作目录用于任务路由，实际文件访问沿用 Agent 权限。</p>
      </>}
      <Dialog open={!!edit} onOpenChange={(open) => !open && !saving && setEdit(undefined)}><DialogContent><DialogHeader><DialogTitle>{edit?.id ? '编辑项目' : '添加项目'}</DialogTitle><DialogDescription>选择具体的本机项目目录。改名不影响绑定；已绑定项目更换目录前需先解绑。</DialogDescription></DialogHeader>{edit && <form onSubmit={(e) => { e.preventDefault(); void mutate({ action: 'save', ...edit }); }} className="space-y-4"><label className="block text-sm space-y-2"><span>项目名称</span><Input required value={edit.name} maxLength={100} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label><label className="block text-sm space-y-2"><span>绝对目录路径</span><Input required value={edit.cwd} placeholder="/Volumes/磁盘/项目目录" onChange={(e) => setEdit({ ...edit, cwd: e.target.value })} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />启用此项目</label><DialogFooter><Button type="button" variant="outline" onClick={() => setEdit(undefined)} disabled={saving}>取消</Button><Button disabled={saving}>{saving ? '保存中…' : '保存项目'}</Button></DialogFooter></form>}</DialogContent></Dialog>
      <Dialog open={!!bind} onOpenChange={(open) => !open && !saving && setBind(undefined)}><DialogContent><DialogHeader><DialogTitle>绑定工作区</DialogTitle><DialogDescription>切换后默认开启新会话。历史可由所有者在对应聊天中使用 /resume 显式恢复。</DialogDescription></DialogHeader>{bind && <div className="space-y-4"><p className="text-sm break-all">{bind.conversation.name ?? bind.conversation.id}</p><select aria-label="选择项目" className={selectClass} value={bind.projectId} onChange={(e) => setBind({ ...bind, projectId: e.target.value })}><option value="">解除绑定，暂停此聊天任务</option>{data?.projects.filter((p) => p.enabled && p.available).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>{bind.conversation.busy && <label className="flex items-start gap-2 text-sm text-amber-800"><input type="checkbox" checked={bind.stop} onChange={(e) => setBind({ ...bind, stop: e.target.checked })} />停止此聊天运行及排队任务，再应用绑定</label>}<DialogFooter>{bind.conversation.type === 'topic' && <Button variant="outline" disabled={saving || (bind.conversation.busy && !bind.stop)} onClick={() => mutate({ action: 'inherit', scope: bind.conversation.id, revision: bind.conversation.revision, stop: bind.stop })}>继承群项目</Button>}<Button disabled={saving || (bind.conversation.busy && !bind.stop)} onClick={() => mutate({ action: bind.projectId ? 'bind' : 'unbind', scope: bind.conversation.id, projectId: bind.projectId, revision: bind.conversation.revision, stop: bind.stop })}>{saving ? '应用中…' : '应用绑定'}</Button></DialogFooter></div>}</DialogContent></Dialog>
    </CardContent>
  </Card>;
}
