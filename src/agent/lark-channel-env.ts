import { join } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export function buildLarkChannelEnv(context?: LarkChannelEnvContext, prompt?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
    // Clear inherited state even for private chats / non-IM agent runs.
    LARK_REPLY_CONTEXT: replyContextFromPrompt(prompt),
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    nonEmpty(context?.configPath) ??
    (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  return env;
}

/** Notification routing metadata, never an authorization credential. */
export function replyContextFromPrompt(prompt?: string): string {
  const match = prompt?.match(/^<bridge_context>\s*([\s\S]*?)\s*<\/bridge_context>/);
  if (!match) return '';
  try {
    const ctx = JSON.parse(match[1]!) as Record<string, unknown>;
    if (ctx.source !== 'im' && ctx.source !== 'card') return '';
    if (ctx.chatType !== 'group' && ctx.chatType !== 'topic') return '';
    if (typeof ctx.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(ctx.chatId)) return '';
    const candidates = Array.isArray(ctx.replyTargets) ? ctx.replyTargets : ctx.senderType === 'bot' ? [] : [ctx.senderId];
    const userIds = [...new Set(candidates.filter((id): id is string => typeof id === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(id) && id !== ctx.botOpenId))];
    return userIds.length ? JSON.stringify({ chatId: ctx.chatId, chatType: ctx.chatType, userIds }) : '';
  } catch { return ''; }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
