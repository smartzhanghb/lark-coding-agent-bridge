import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/** Read only model metadata, never expose credentials or execute the CLI. */
export function supportedModels(agentKind: AgentKind, cwd?: string): ModelOption[] {
  if (agentKind === 'codex') return [...CODEX_MODELS];
  const settings: Record<string, unknown> = {};
  const env: Record<string, unknown> = {};
  const files = [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : [])];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(settings, raw);
      Object.assign(env, raw.env);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return [CLAUDE_MODELS[0]!];
    }
  }
  Object.assign(env, process.env);
  const picker = settings.modelPicker as { options?: { model?: unknown; label?: unknown }[] } | undefined;
  const configured = new Map<string, ModelOption>();
  if (Array.isArray(picker?.options)) for (const option of picker.options) {
    if (typeof option?.model !== 'string' || !validModelId(option.model) || option.model === DEFAULT_MODEL) continue;
    configured.set(option.model, { value: option.model, label: typeof option.label === 'string' && option.label.trim() ? option.label : option.model });
  }
  // Custom menus replace the bridge's static Anthropic catalog. Keep the exact
  // model id, including context suffixes such as [1M], for --model.
  if (configured.size) return [CLAUDE_MODELS[0]!, ...configured.values()];
  for (const alias of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) {
    const value = env[`ANTHROPIC_DEFAULT_${alias}_MODEL`];
    const label = env[`ANTHROPIC_DEFAULT_${alias}_MODEL_NAME`];
    if (typeof value === 'string' && validModelId(value)) configured.set(value, { value, label: typeof label === 'string' && label ? label : value });
  }
  for (const value of [env.ANTHROPIC_MODEL, settings.model]) if (typeof value === 'string' && validModelId(value)) {
    if (!configured.has(value)) configured.set(value, { value, label: value });
  }
  if (configured.size) return [CLAUDE_MODELS[0]!, ...configured.values()];
  // A custom endpoint without model metadata must not advertise Anthropic models.
  if (env.ANTHROPIC_BASE_URL || picker) return [CLAUDE_MODELS[0]!];
  return [...CLAUDE_MODELS];
}
export function validModelId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value) && !value.startsWith('-');
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
  cwd?: string,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels(agentKind, cwd).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
  cwd?: string,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value, cwd);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined, cwd?: string): string {
  const normalized = normalizeModelSelection(agentKind, value, cwd);
  return supportedModels(agentKind, cwd).find((m) => m.value === normalized)?.label ?? normalized;
}
