// Probe the trusted gateway configured for this Claude profile, without starting an agent.
import { readFile, writeFile, unlink, mkdir, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.env.LARK_CHANNEL_HOME || join(homedir(), '.lark-channel');
const logs = join(root, 'logs');
const state = join(logs, 'model-sentinel.state');
const checkOnly = process.argv.includes('--check');
async function json(path, optional = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (err) { if (optional && err.code === 'ENOENT') return {}; throw err; }
}

async function probe() {
  const config = await json(join(root, 'config.json'));
  const profile = config.activeProfile;
  const cfg = config.profiles[profile];
  if (cfg.agentKind !== 'claude') throw new Error('当前 profile 不是 Claude');
  const dir = join(root, 'profiles', profile);
  // The monitor's shell can belong to a different provider. Use the Bridge service's environment.
  const plist = join(homedir(), 'Library', 'LaunchAgents', 'ai.lark-channel-bridge.bot.' + profile + '.plist');
  const service = JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', plist],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const base = await json(join(service.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'));
  const extra = await json(join(dir, 'claude-settings.json'), true);
  let trusted = { ...base.env };
  for (const layer of [extra.env, service]) {
    if (layer?.ANTHROPIC_BASE_URL && layer.ANTHROPIC_BASE_URL !== trusted.ANTHROPIC_BASE_URL) {
      if (!layer.ANTHROPIC_AUTH_TOKEN && !layer.ANTHROPIC_API_KEY) throw new Error('独立网关缺少配套凭据');
      delete trusted.ANTHROPIC_AUTH_TOKEN;
      delete trusted.ANTHROPIC_API_KEY;
    }
    trusted = { ...trusted, ...layer };
  }
  if (!trusted.ANTHROPIC_BASE_URL) throw new Error('缺少网关地址');
  const endpoint = new URL(trusted.ANTHROPIC_BASE_URL.replace(/\/$/, '') + '/v1/messages');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('不安全的网关地址');
  const token = trusted.ANTHROPIC_AUTH_TOKEN || trusted.ANTHROPIC_API_KEY;
  if (!token) throw new Error('缺少网关凭据');
  const workspaces = await json(join(dir, 'workspaces.json'), true);
  const projects = cfg.workspaces.managedBindings ? Object.values(workspaces.projects || {}).filter(p => p.enabled) : [];
  const models = new Set();
  for (const project of [{ cwd: cfg.workspaces.default }, ...projects]) {
    const cwd = project.cwd;
    const projectSettings = cwd ? await json(join(cwd, '.claude', 'settings.json'), true) : {};
    const local = cwd ? await json(join(cwd, '.claude', 'settings.local.json'), true) : {};
    const env = { ...trusted, ...projectSettings.env, ...local.env, ...extra.env, ...service };
    // A workspace cannot redirect the monitor and its credential to a different endpoint.
    if (env.ANTHROPIC_BASE_URL !== trusted.ANTHROPIC_BASE_URL ||
        (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) !== token) throw new Error('项目使用独立网关，需要独立探测配置');
    let model = project.model ?? cfg.preferences.model;
    if (!model || model === 'default') model = env.ANTHROPIC_MODEL || extra.model || local.model ||
      projectSettings.model || base.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    if (!model) throw new Error('缺少运行模型');
    model = model.replace(/\[1m\]$/i, '');
    const overrides = { ...base.modelOverrides, ...projectSettings.modelOverrides, ...local.modelOverrides, ...extra.modelOverrides };
    models.add(overrides[model] || env['ANTHROPIC_DEFAULT_' + model.toUpperCase() + '_MODEL']?.replace(/\[1m\]$/i, '') || model);
  }
  const auth = trusted.ANTHROPIC_AUTH_TOKEN ? { authorization: 'Bearer ' + token } : { 'x-api-key': token };
  for (const model of models) {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' · ' + model);
    const result = await response.json();
    if (result.type !== 'message' || !Array.isArray(result.content)) throw new Error('网关响应无效');
  }
  return [...models].join(', ');
}

async function notify(title, message) {
  const { env } = await json(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'));
  if (!env?.BARK_SERVER || !env.BARK_DEVICE_KEY) throw new Error('缺少 Bark 告警配置');
  const url = [env.BARK_SERVER.replace(/\/$/, ''), ...[env.BARK_DEVICE_KEY, title, message].map(encodeURIComponent)].join('/') + '?group=LarkBot';
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || (await response.json()).code !== 200) throw new Error('Bark 告警发送失败');
}
async function log(message) {
  await mkdir(logs, { recursive: true });
  await appendFile(join(logs, 'model-sentinel.log'), new Date().toISOString() + ' ' + message + '\n', { mode: 0o600 });
}
try {
  let result;
  try { result = await probe(); }
  catch (first) {
    if (checkOnly) throw first;
    await new Promise(resolve => setTimeout(resolve, 30_000));
    result = await probe();
  }
  if (checkOnly) console.log('健康 · ' + result);
  else {
    const alarm = await readFile(state, 'utf8').catch(err => { if (err.code !== 'ENOENT') throw err; });
    if (alarm) { await notify('Bridge 模型探测恢复', result); await unlink(state); }
    await log('健康 · ' + result);
  }
} catch (err) {
  // Never write request headers, gateway response bodies or a callback URL.
  const safe = /^(HTTP \d{3} · [\w.\-[\]]+|[\u3400-\u9fff A-Za-z]+)$/.test(err.message) ? err.message : '配置或网络检查失败';
  if (checkOnly) console.error(safe);
  else {
    await log('故障 · ' + safe);
    const previous = await readFile(state, 'utf8').catch(() => '');
    if (previous !== safe) {
      await notify('Bridge 模型探测失败', safe);
      await writeFile(state, safe, { mode: 0o600 });
    }
  }
  process.exitCode = 1;
}
